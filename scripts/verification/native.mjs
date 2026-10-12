// A deterministic fake native CLI. It uses the real installed wrapper/router,
// and models an account-bound incremental response that needs exact resume.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const root = process.env.UNSNOOZE_E2E_ROOT;
if (!root || resolve(homedir()) !== resolve(root, 'home') || !existsSync(join(root, 'ISOLATED-VERIFICATION'))) {
  throw new Error('Fake native CLI requires an isolated fixture.');
}
const [provider, ...args] = process.argv.slice(2);
const setting = name => args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1);
const option = name => args[args.indexOf(name) + 1];
const resuming = args.includes('resume') || args.includes('--resume') || args.includes('--conversation');
const sessionId = resuming ? option(provider === 'codex' ? 'resume' : provider === 'claude' ? '--resume' : '--conversation')
  : process.env.UNSNOOZE_E2E_SESSION;
appendFileSync(join(root, 'native-events.jsonl'), JSON.stringify({ provider, args, sessionId, resuming }) + '\n', { mode: 0o600 });
if (process.env.UNSNOOZE_E2E_ARGV_ONLY === '1') process.exit(0);
if (provider === 'agy') {
  const native = JSON.parse(readFileSync(join(homedir(), '.gemini/antigravity-cli/antigravity-oauth-token'), 'utf8'));
  if (!native.token.access_token.startsWith('fixture-')) throw new Error('Unexpected native credential.');
  process.stdout.write('READY agy\n');
  if (process.env.UNSNOOZE_E2E_AGY_HOLD === '1' && !resuming) {
    setInterval(() => {}, 1_000);
    await new Promise(() => {});
  }
  process.exit(0);
}
const base = provider === 'claude' ? process.env.ANTHROPIC_BASE_URL : JSON.parse(setting('model_providers.unsnooze.base_url'));
const launch = provider === 'claude' ? /x-unsnooze-launch:\s*([^\n]+)/.exec(process.env.ANTHROPIC_CUSTOM_HEADERS)?.[1]
  : /"x-unsnooze-launch"="([^"]+)"/.exec(setting('model_providers.unsnooze.http_headers'))?.[1];
const token = provider === 'claude' ? process.env.CLAUDE_CODE_OAUTH_TOKEN : process.env.UNSNOOZE_ROUTER_TOKEN;
const request = previous => fetch(`${base}/${provider === 'claude' ? 'v1/messages' : 'responses'}`, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
    session_id: sessionId, 'x-unsnooze-launch': launch },
  body: JSON.stringify({ model: provider === 'claude' ? 'claude-sonnet-4-5' : 'gpt-5',
    input: [{ role: 'user', content: 'fixture conversation history' }],
    ...(previous ? { previous_response_id: 'fixture-response' } : {}) }),
});
const first = await request(false);
if (!first.ok) throw new Error(`Fixture native request failed (${first.status}).`);
await first.text();
if (provider === 'codex' && !resuming && process.env.UNSNOOZE_E2E_CHAIN === '1') {
  const chained = await request(true);
  if (chained.status !== 409) throw new Error(`Expected an account-bound resume (${chained.status}).`);
  await chained.text();
  // Stay alive as a real CLI would. The wrapper, not the fixture, detects the
  // durable request and terminates this child before resuming the same ID.
  setInterval(() => {}, 1_000);
} else process.stdout.write(`READY ${provider}\n`);
