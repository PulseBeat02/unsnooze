// A separate, sequential acceptance check against an actually installed tarball.
// All credentials, native CLIs, provider responses, shells and deployment paths
// are disposable fixtures. No installed user program or native token is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, readFileSync, existsSync, copyFileSync,
  chmodSync, statSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const artifact = JSON.parse(readFileSync(resolve(process.argv[2]), 'utf8'));
const output = resolve(process.argv[3]);
mkdirSync(output, { recursive: true, mode: 0o700 });
const root = mkdtempSync(join(output, 'fixture-'));
const home = join(root, 'home'), state = join(home, '.unsnooze'), prefix = join(home, '.npm-global');
const privateFile = (path, value) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  return path;
};
privateFile(join(root, 'ISOLATED-VERIFICATION'), 'fake providers and credentials only\n');
mkdirSync(home, { recursive: true, mode: 0o700 });
mkdirSync(join(root, 'tmp'), { recursive: true, mode: 0o700 });
const environment = { HOME: home, PATH: `${prefix}/bin:${join(root, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`,
  TMPDIR: join(root, 'tmp'), npm_config_cache: process.env.npm_config_cache || join(root, 'npm-cache'),
  LANG: 'C.UTF-8', UNSNOOZE_STATE_DIR: state, UNSNOOZE_UPDATE_CHECK: '0', UNSNOOZE_NOTIFICATIONS: 'off',
  UNSNOOZE_MULTIPLEXER: 'headless', UNSNOOZE_ACCOUNT_RECONCILE_MS: '1000',
  UNSNOOZE_POLL_INTERVAL_MS: '150', UNSNOOZE_VERIFY_DELAY_MS: '150',
  UNSNOOZE_CLAUDE_DIR: join(home, '.claude'), UNSNOOZE_CODEX_DIR: join(home, '.codex'),
  UNSNOOZE_E2E_ROOT: root };
const results = [], requests = [], failures = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const read = path => JSON.parse(readFileSync(path, 'utf8'));
async function until(check, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  do { const value = await check(); if (value) return value; await sleep(75); } while (Date.now() < deadline);
  throw new Error('Acceptance condition did not become true before deadline.');
}
async function command(file, args, { env = environment, cwd = root, codes = [0], timeoutMs = 45_000, input } = {}) {
  const child = spawn(file, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } }, timeoutMs);
  child.stdin.end(input);
  const [code] = await once(child, 'close');
  clearTimeout(timer);
  assert.doesNotMatch(stdout + stderr, /fixture-secret-/, 'credentials stay out of command output');
  appendFileSync(join(output, 'commands.jsonl'), JSON.stringify({ file, args, code, stdout, stderr }) + '\n', { mode: 0o600 });
  assert.equal(timedOut, false, `${file} timed out`);
  assert.ok(codes.includes(code), `${file} ${args.slice(0, 3).join(' ')} exited ${code}: ${stderr}`);
  return { code, stdout, stderr };
}
const cli = (...args) => command(join(prefix, 'bin/unsnooze'), args);
const runCli = (args, options) => command(join(prefix, 'bin/unsnooze'), args, options);
const jsonCli = async (...args) => JSON.parse((await cli(...args)).stdout);
async function step(name, fn) {
  const startedAt = new Date().toISOString();
  await fn(); results.push({ name, startedAt, completedAt: new Date().toISOString() });
  console.log(`PASS ${name}`);
}
const accounts = () => read(join(state, 'accounts.json')).providers;
const accountIds = provider => accounts()[provider].accounts.filter(a => a.enabled).map(a => a.id);
let usage = { ca: 42.75, cb: 4, c1: 12, c2: 7, c3: 0, ga: 0.50544, gb: 0 };
let offline = false, expired = null, rejected = null, rejectChained = false, holdAccount = null;
let held = false, quotaResetAt = null;
const providerServer = createServer(async (req, res) => {
  try {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString();
  const body = raw ? JSON.parse(raw) : null;
  const key = String(req.headers.authorization ?? '').replace('Bearer fixture-secret-', '');
  const path = req.url;
  const send = (body, status = 200, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  if (offline) { req.socket.destroy(); return; }
  if (!(key in usage)) { send({ error: 'unknown fixture account' }, 401); return; }
  if (expired === key) { send({ error: 'expired fixture login' }, 401); return; }
  if (quotaResetAt && Date.now() >= quotaResetAt) { usage.c1 = 0; quotaResetAt = null; }
  const reset = quotaResetAt ? Math.ceil(quotaResetAt / 1000) : Math.floor(Date.now() / 1000) + 3600;
  if (path.endsWith('/api/oauth/usage')) {
    send({ five_hour: { utilization: usage[key], resets_at: new Date(reset * 1000).toISOString() },
      seven_day: { utilization: 65, resets_at: new Date((reset + 604800) * 1000).toISOString() } });
  } else if (path.endsWith('/wham/usage')) {
    assert.equal(req.headers['chatgpt-account-id'], `workspace-${key}`);
    send({ rate_limit: { primary_window: { used_percent: usage[key], reset_at: reset,
      limit_window_seconds: key === 'c2' ? 604800 : 18000 }, secondary_window: key === 'c2' ? null
        : { used_percent: 16, reset_at: reset + 604800, limit_window_seconds: 604800 } } });
  } else if (path.includes('daily-cloudcode-pa.googleapis.com')) {
    assert.equal(req.headers['user-agent'], 'antigravity');
    if (path.endsWith(':loadCodeAssist')) {
      assert.deepEqual(body, { metadata: { ideType: 'ANTIGRAVITY', platform: 'LINUX_AMD64', pluginType: 'GEMINI' } });
      send({ cloudaicompanionProject: 'fixture-project' });
    } else {
      assert.deepEqual(body, { project: 'fixture-project' });
      send({ groups: ['Gemini Models', 'Claude and GPT models'].map((displayName, i) => ({ displayName,
        buckets: ['5h', 'weekly'].map((window, w) => ({ bucketId: `${i}-${window}`, window,
          remainingFraction: 1 - (i ? 0 : w ? 0.08424 : usage[key]) / 100,
          resetTime: new Date((reset + w * 604800) * 1000).toISOString() })) })) });
    }
  } else if (path.endsWith('/responses') || path.endsWith('/messages')) {
    requests.push({ key, path, body, sessionId: req.headers.session_id });
    if (holdAccount === key) { held = true; return; }
    if (rejected === key || (rejectChained && key === 'c1' && body.previous_response_id)) {
      usage[key] = 100;
      send({ error: { type: 'usage_limit_reached' } }, 429, key.startsWith('c') && key.length === 2 && /[ab]/.test(key[1])
        ? { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-5h-status': 'rejected',
          'anthropic-ratelimit-unified-5h-utilization': '1', 'anthropic-ratelimit-unified-5h-reset': String(reset) }
        : { 'x-codex-primary-used-percent': '100' });
    } else send({ id: 'fixture-response', result: 'READY' });
  } else { failures.push(`Unexpected provider path ${path}`); send({ error: 'unexpected fixture path' }, 500); }
  } catch (error) {
    failures.push(error.message);
    if (!res.headersSent) res.writeHead(500);
    res.end('Fixture assertion failed.');
  }
});
providerServer.on('clientError', (_err, socket) => socket.destroy());
await new Promise(r => providerServer.listen(0, '127.0.0.1', r));
environment.UNSNOOZE_E2E_ENDPOINT = `http://127.0.0.1:${providerServer.address().port}`;
const portProbe = createServer(); await new Promise(r => portProbe.listen(0, '127.0.0.1', r));
environment.UNSNOOZE_ROUTER_PORT = String(portProbe.address().port);
await new Promise(r => portProbe.close(r));
const preload = fileURLToPath(new URL('./verification/preload.mjs', import.meta.url));
const native = fileURLToPath(new URL('./verification/native.mjs', import.meta.url));
const nativeEvents = () => existsSync(join(root, 'native-events.jsonl'))
  ? readFileSync(join(root, 'native-events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
let installed = false, ca, cb, c1, c2, ga, gb, oldArchive;
const backupSuffix = `.bak-unsnoozefork-${new Date().toISOString().replaceAll('-', '').replaceAll(':', '').replace(/\.\d+Z$/, 'Z')}`;
const sourceBytes = new Map(), originals = new Map();
const nativeToken = key => ({ token: { access_token: `fixture-secret-${key}`, refresh_token: `fixture-refresh-${key}`,
  expiry: new Date(Date.now() + 86_400_000).toISOString() }, auth_method: 'oauth' });
const capture = path => { sourceBytes.set(path, readFileSync(path)); return path; };
const usageCli = async () => JSON.parse((await runCli(['usage', '--json', '--refresh'], { codes: [0, 1, 2] })).stdout);
const select = (provider, id) => cli('accounts', 'switch', provider, id);
const status = async () => JSON.parse((await runCli(['daemon', 'status', '--json'], { codes: [0, 1] })).stdout);
async function routed(provider, sessionId, body = { model: 'gpt-5', input: 'unchanged fixture transcript' }) {
  const token = readFileSync(join(state, 'router-token'), 'utf8');
  const response = await fetch(`http://127.0.0.1:${environment.UNSNOOZE_ROUTER_PORT}/${provider}/${provider === 'claude' ? 'v1/messages' : 'responses'}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, session_id: sessionId, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.json() };
}
try {
  await step('staged gate and original installation', async () => {
    assert.equal(existsSync(join(root, 'MAINTENANCE-DONE')), false);
    assert.equal(existsSync(prefix), false);
    const old = join(root, 'old-package');
    privateFile(join(old, 'package.json'), { name: 'unsnooze', version: '1.19.0', bin: { unsnooze: 'bin.js' } });
    privateFile(join(old, 'bin.js'), '#!/usr/bin/env node\nconsole.log("1.19.0");\n');
    chmodSync(join(old, 'bin.js'), 0o700);
    const packed = await command('npm', ['pack', '--json'], { cwd: old });
    oldArchive = join(old, JSON.parse(packed.stdout)[0].filename);
    await command('npm', ['install', '-g', '--prefix', prefix, oldArchive, '--no-audit', '--no-fund']);
    assert.equal((await cli('--version')).stdout.trim(), '1.19.0');
    for (const name of ['.bashrc', '.profile', '.config/claude-rotate.env', '.codex/config.toml']) {
      const path = privateFile(join(home, name), `# original fixture ${name}\n`);
      originals.set(path, readFileSync(path));
      copyFileSync(path, path + backupSuffix); chmodSync(path + backupSuffix, 0o600);
    }
    privateFile(join(root, 'MAINTENANCE-DONE'), 'isolated simulated host gate\n');
  });
  await step('install immutable artifact in private prefix', async () => {
    assert.ok(existsSync(join(root, 'MAINTENANCE-DONE')));
    await command('npm', ['install', '-g', '--prefix', prefix, artifact.archive, '--no-audit', '--no-fund'], { timeoutMs: 120_000 });
    installed = true;
    assert.equal((await cli('--version')).stdout.trim(), artifact.version);
    environment.NODE_OPTIONS = `--import=${preload}`;
    for (const provider of ['claude', 'codex', 'agy']) {
      const path = privateFile(join(root, 'bin', provider), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(native)} ${quote(provider)} "$@"\n`);
      chmodSync(path, 0o700);
      environment[`UNSNOOZE_${provider.toUpperCase()}_BIN`] = path;
    }
    environment.UNSNOOZE_CODEX_DIRECT_BIN = join(root, 'bin/codex');
    Object.assign(process.env, environment);
    await import(pathToFileURL(preload));
  });
  await step('import all four original accounts without changing source credentials', async () => {
    const dir = join(home, '.local/opt/claude-rotate');
    capture(privateFile(join(dir, 'tokens/linboston'), 'fixture-secret-ca'));
    capture(privateFile(join(dir, 'config.json'), { accounts: [{ name: 'linboston', token_file: 'tokens/linboston' }] }));
    capture(privateFile(join(home, '.codex/multi-auth/openai-codex-accounts.json'), {
      activeIndex: 0, accounts: ['c1', 'c2'].map((recordId, i) => ({ recordId, accountLabel: `Account ${i + 1}`,
        accessToken: `fixture-secret-${recordId}`, refreshToken: `fixture-refresh-${recordId}`, accountId: `workspace-${recordId}` })) }));
    capture(privateFile(join(home, '.gemini/antigravity-cli/antigravity-oauth-token'), nativeToken('ga')));
    assert.match((await cli('accounts', 'import', 'all')).stdout, /Imported 4 account references/);
    assert.match((await cli('accounts', 'import', 'all')).stdout, /Imported 0 account references/);
    [ca] = accountIds('claude'); [c1, c2] = accountIds('codex'); [ga] = accountIds('agy');
    const listing = await jsonCli('accounts', 'list', '--json');
    assert.equal(listing.providers.codex.accounts.length, 2);
    assert.doesNotMatch(JSON.stringify(listing), /credential|fixture-secret/);
    for (const [path, data] of sourceBytes) assert.deepEqual(readFileSync(path), data);
    assert.equal(statSync(join(state, 'accounts.json')).mode & 0o777, 0o600);
  });
  await step('exact Claude, both Codex accounts and both AGY quota groups', async () => {
    const measured = await usageCli();
    const expected = { claude: [[42.75, 65]], codex: [[12, 16], [7]], agy: [[0.50544, 0.08424, 0, 0]] };
    for (const [provider, windows] of Object.entries(expected)) {
      assert.deepEqual(measured.providers[provider].accounts.map(a => a.windows.map(w => w.usedPercent)), windows);
      for (const a of measured.providers[provider].accounts) {
        assert.equal(a.status, 'ok'); assert.equal(a.stale, false); assert.ok(a.fetchedAt > 0);
        assert.ok(a.windows.every(w => w.resetAt > Date.now()));
      }
    }
    assert.equal(measured.providers.codex.accounts[1].windows[0].label, 'weekly');
    privateFile(join(output, 'measured-fixture-usage.json'), measured);
    // The Usage TUI and CLI consume this same public report builder.
    const { buildAccountUsageReport, formatAccountUsageText } = await import(pathToFileURL(join(prefix, 'lib/node_modules/unsnooze/src/usage.js')));
    const report = buildAccountUsageReport({ providers: measured.providers, fetchedAt: measured.accountUsageFetchedAt });
    assert.match(formatAccountUsageText(report), /42.75%/);
  });
  await step('add/list/enable/disable/switch/pin/unpin/policy for every provider', async () => {
    const paths = {
      claude: privateFile(join(root, 'references/claude-b'), 'fixture-secret-cb'),
      codex: privateFile(join(root, 'references/codex-c.json'), { accounts: [{ recordId: 'c3', accessToken: 'fixture-secret-c3', accountId: 'workspace-c3' }] }),
      agy: privateFile(join(root, 'references/agy-b.json'), nativeToken('gb')),
    };
    for (const provider of ['claude', 'codex', 'agy']) {
      const id = `${provider}-extra`;
      await cli('accounts', 'add', provider, 'Extra', '--id', id, '--path', paths[provider], '--disabled',
        ...(provider === 'codex' ? ['--record-id', 'c3'] : []));
      await runCli(['accounts', 'switch', provider, id], { codes: [1] });
      await cli('accounts', 'enable', provider, id); await select(provider, id);
      await cli('accounts', 'pin', provider, id);
      assert.equal(accounts()[provider].pinnedAccountId, id);
      const original = { claude: ca, codex: c1, agy: ga }[provider];
      await runCli(['accounts', 'switch', provider, original], { codes: [1] });
      await cli('accounts', 'unpin', provider); await cli('accounts', 'disable', provider, id);
      assert.equal(accounts()[provider].activeAccountId, null);
      await cli('accounts', 'enable', provider, id); await select(provider, original);
      await cli('accounts', 'policy', provider, '--threshold-percent', '95', '--cooldown-ms', '0', '--strategy', 'headroom');
      assert.equal(accounts()[provider].policy.cooldownMs, 0);
    }
    cb = 'claude-extra'; gb = 'agy-extra';
    await cli('accounts', 'disable', 'codex', 'codex-extra');
  });
  await step('wrapper auto-start, native routing and exact resume for each provider', async () => {
    assert.equal((await status()).healthy, false);
    for (const provider of ['claude', 'codex', 'agy']) {
      const session = `${provider}-same-session`;
      const env = { ...environment, UNSNOOZE_E2E_SESSION: session };
      await runCli(['_run', provider, '-p', 'READY'], { env });
      await runCli(['_run', provider, ...(provider === 'codex' ? ['resume', session]
        : provider === 'claude' ? ['--resume', session] : ['--conversation', session]), '-p', 'READY'], { env });
      const events = nativeEvents().filter(e => e.provider === provider);
      assert.equal(events.at(-1).sessionId, session); assert.equal(events.at(-1).resuming, true);
    }
    const first = await status(); assert.equal(first.healthy, true);
    await cli('daemon', 'ensure'); await cli('daemon', 'start');
    assert.equal((await status()).supervisorPid, first.supervisorPid);
    const unauthorized = await fetch(`http://127.0.0.1:${first.port}/health`);
    assert.equal(unauthorized.status, 401); await unauthorized.text();
  });
  await step('Claude and Codex limit rejection switches without losing payload or session', async () => {
    for (const [provider, first, second, key] of [['claude', ca, cb, 'ca'], ['codex', c1, c2, 'c1']]) {
      usage[key] = 0; rejected = key; await usageCli(); await select(provider, first);
      const before = requests.length;
      const response = await routed(provider, `${provider}-limit-stop`);
      assert.equal(response.status, 200);
      assert.equal(accounts()[provider].activeAccountId, second);
      const trace = requests.slice(before);
      assert.equal(trace.length, 2); assert.deepEqual(trace[0].body, trace[1].body);
      assert.equal(trace[0].sessionId, trace[1].sessionId);
    }
    rejected = null;
  });
  await step('policy threshold, pin and never-switch gates', async () => {
    usage.c1 = 96; usage.c2 = 5; await usageCli(); await select('codex', c1);
    assert.equal((await routed('codex', 'threshold')).status, 200);
    assert.equal(accounts().codex.activeAccountId, c2);
    await cli('accounts', 'pin', 'codex', c1);
    assert.equal((await routed('codex', 'pinned')).status, 200);
    assert.equal(accounts().codex.activeAccountId, c1);
    await cli('accounts', 'unpin', 'codex');
    await cli('accounts', 'policy', 'codex', '--never-switch', 'true');
    assert.equal((await routed('codex', 'never-switch')).status, 200);
    assert.equal(accounts().codex.activeAccountId, c1);
    await cli('accounts', 'policy', 'codex', '--never-switch', 'false');
  });
  await step('account-bound Codex chain triggers real child termination and exact session restart', async () => {
    usage.c1 = 0; usage.c2 = 5; await usageCli(); await select('codex', c1); rejectChained = true;
    const before = nativeEvents().length;
    await runCli(['_run', 'codex', '-p', 'READY'], { env: { ...environment, UNSNOOZE_E2E_SESSION: 'chain-same-session', UNSNOOZE_E2E_CHAIN: '1' } });
    const launches = nativeEvents().slice(before);
    assert.equal(launches.length, 2);
    assert.equal(launches[0].sessionId, launches[1].sessionId);
    assert.equal(launches[1].sessionId, 'chain-same-session'); assert.equal(launches[1].resuming, true);
    assert.ok(!requests.at(-1).body.previous_response_id, 'native resume reconstructs full transcript');
    rejectChained = false;
  });
  await step('all accounts exhausted waits, then fresh reset evidence clears stale routing blocks', async () => {
    usage.c1 = 100; usage.c2 = 100; await usageCli();
    // Keep the fixture clock parked until both blocked attempts are observed;
    // a slow host must not accidentally advance past the reset during setup.
    quotaResetAt = Date.now() + 60_000; await usageCli();
    const { upsertSession, readState, updateState } = await import(pathToFileURL(join(prefix, 'lib/node_modules/unsnooze/src/state.js')));
    upsertSession({ agent: 'codex', sessionId: 'parked-same-session', cwd: root,
      pane: null, mux: 'headless', paneOwner: null, status: 'stopped', limitType: '5h',
      detectedAt: Date.now(), resetAt: Date.now() + 3_600_000, resetSource: 'absolute', attempts: 0 });
    const parked = () => Object.values(readState().sessions).find(r => r.sessionId === 'parked-same-session');
    const before = requests.length;
    assert.equal((await routed('codex', 'parked-same-session')).status, 429);
    assert.equal(requests.length, before, 'parked request does not generate provider work');
    await sleep(150);
    assert.equal((await routed('codex', 'parked-same-session')).status, 429);
    assert.equal(parked().status, 'stopped');
    quotaResetAt = Date.now() + 500;
    await until(() => Date.now() >= quotaResetAt);
    await usageCli();
    await until(() => nativeEvents().some(e => e.sessionId === 'parked-same-session' && e.resuming));
    assert.equal(parked().resetSource, 'account-usage', 'daemon clears the stale local timer only after a live check');
    await until(() => requests.some(r => r.sessionId === 'parked-same-session'));
    updateState(s => { for (const [key, record] of Object.entries(s.sessions)) if (record.sessionId === 'parked-same-session') delete s.sessions[key]; });
  });
  await step('real Antigravity native child switches and resumes its detected conversation', async () => {
    const installedSrc = join(prefix, 'lib/node_modules/unsnooze/src');
    const { runManagedAgy, readAgyJournal } = await import(pathToFileURL(join(installedSrc, 'accounts/agy.js')));
    const { runLauncher } = await import(pathToFileURL(join(installedSrc, 'launcher.js')));
    const { detectLimit } = await import(pathToFileURL(join(installedSrc, 'patterns.js')));
    const { patterns } = await import(pathToFileURL(join(installedSrc, 'agents/agy.js')));
    const detection = detectLimit('Individual quota reached. Refreshes in 5 hours.', 12, patterns);
    assert.equal(detection.hit, true);
    usage.ga = 0; usage.gb = 0; await select('agy', ga); await usageCli();
    const ledger = { sessions: {} }, before = nativeEvents().length;
    let launches = 0, poll;
    process.env.UNSNOOZE_E2E_AGY_HOLD = '1'; process.env.UNSNOOZE_E2E_SESSION = 'agy-handoff-same-session';
    try {
      const code = await runManagedAgy(['-p', 'READY'], { stateDir: state, intervalMs: 75,
        readStateFn: () => ledger, updateStateFn: fn => fn(ledger),
        launchFn: (args, provider, options) => {
          launches++;
          return runLauncher(args, provider, { ...options, onChild(child, lease) {
            options.onChild(child, lease);
            if (launches !== 1) return;
            poll = setInterval(() => {
              if (nativeEvents().length === before) return;
              clearInterval(poll); usage.ga = 100;
              ledger.sessions.stop = { key: 'stop', agent: 'agy', leaseId: lease.leaseId, status: 'stopped',
                sessionId: 'agy-handoff-same-session', detectedAt: Date.now(), limitType: detection.limitType };
            }, 50);
          } });
        },
      });
      assert.equal(code, 0); assert.equal(launches, 2);
      assert.equal(accounts().agy.activeAccountId, gb);
      assert.equal(nativeEvents().at(-1).sessionId, 'agy-handoff-same-session');
      assert.equal(nativeEvents().at(-1).resuming, true);
      assert.equal(ledger.sessions.stop.status, 'resuming'); assert.equal(readAgyJournal(state).phase, 'complete');
    } finally {
      clearInterval(poll); delete process.env.UNSNOOZE_E2E_AGY_HOLD; delete process.env.UNSNOOZE_E2E_SESSION;
    }
  });
  await step('expired login and network loss remain distinct from exhausted quota', async () => {
    await select('codex', c1); expired = 'c1';
    assert.equal((await usageCli()).providers.codex.accounts[0].status, 'expired_login');
    assert.equal((await routed('codex', 'expired')).status, 401);
    expired = null; offline = true;
    const report = await usageCli();
    assert.ok(Object.values(report.providers).flatMap(p => p.accounts).filter(a => a.enabled).every(a => a.status === 'network_error'));
    assert.equal((await routed('codex', 'offline')).status, 503);
    offline = false; await usageCli();
  });
  await step('concurrent sessions agree on one replacement account', async () => {
    usage.c1 = 100; usage.c2 = 0; await usageCli(); await select('codex', c1);
    const responses = await Promise.all(['race-one', 'race-two'].map(id => routed('codex', id)));
    assert.ok(responses.every(r => r.status === 200));
    assert.equal(accounts().codex.activeAccountId, c2);
    assert.ok(requests.slice(-2).every(r => r.key === 'c2'));
  });
  await step('worker killed after committed switch recovers on same port and conversation', async () => {
    usage.c1 = 0; usage.c2 = 0; await usageCli(); await select('codex', c1);
    rejected = 'c1'; holdAccount = 'c2'; held = false;
    const initial = await status();
    const pending = routed('codex', 'crash-same-session').catch(() => null);
    await until(() => held && accounts().codex.activeAccountId === c2);
    process.kill(initial.pid, 'SIGKILL'); await pending; holdAccount = null; rejected = null;
    const recovered = await until(async () => { const s = await status(); return s.healthy && s.pid !== initial.pid && s; });
    assert.equal(recovered.port, initial.port); assert.equal(recovered.supervisorPid, initial.supervisorPid);
    assert.equal((await routed('codex', 'crash-same-session')).status, 200);
    assert.equal(requests.at(-1).key, 'c2'); assert.equal(requests.at(-1).sessionId, 'crash-same-session');
  });
  await step('supervisor killed, ensure recovers singleton; stop/start stay idempotent', async () => {
    const initial = await status(); process.kill(initial.supervisorPid, 'SIGKILL');
    await until(async () => !(await status()).healthy);
    await cli('daemon', 'ensure');
    const recovered = await status(); assert.equal(recovered.healthy, true);
    assert.notEqual(recovered.supervisorPid, initial.supervisorPid);
    await cli('daemon', 'stop'); await cli('daemon', 'stop');
    assert.equal((await status()).healthy, false);
    await cli('daemon', 'ensure');
  });
  await step('corrupt account config and routing state fail closed and recover after repair', async () => {
    await cli('daemon', 'stop');
    for (const name of ['accounts.json', 'routing-state.json']) {
      const path = join(state, name), before = readFileSync(path);
      privateFile(path, '{broken fixture-private-data');
      if (name === 'accounts.json') {
        await runCli(['accounts', 'list', '--json'], { codes: [1] });
        await runCli(['accounts', 'enable', 'codex', c1], { codes: [1] });
      } else {
        await cli('daemon', 'ensure'); assert.equal((await routed('codex', 'corrupt-state')).status, 502);
        await cli('daemon', 'stop');
      }
      assert.equal(readFileSync(path, 'utf8'), '{broken fixture-private-data');
      writeFileSync(path, before);
    }
    await cli('daemon', 'ensure'); assert.equal((await routed('codex', 'repaired')).status, 200);
  });
  await step('staged shell migration, continuation flags, heartbeat and host handshake', async () => {
    const installedBin = join(prefix, 'lib/node_modules/unsnooze/bin');
    const shell = `source ${quote(join(installedBin, 'unsnooze-shell.bash'))}\n`;
    privateFile(join(home, '.bashrc'), shell); privateFile(join(home, '.profile'), shell);
    privateFile(join(home, '.config/claude-rotate.env'), `export ANTHROPIC_BASE_URL=http://127.0.0.1:${environment.UNSNOOZE_ROUTER_PORT}/claude\n`);
    const before = nativeEvents().length;
    const env = { ...environment, UNSNOOZE_E2E_ARGV_ONLY: '1' };
    for (const commandLine of ['claude -c', 'codex -c', 'codex -c model="fixture"', 'agy -c']) {
      await command('bash', ['--noprofile', '--norc', '-c', `source "$HOME/.bashrc"; ${commandLine}`], { env });
    }
    const events = nativeEvents().slice(before);
    assert.equal(events.length, 4);
    assert.ok(events[0].args.includes('-c'));
    assert.deepEqual(events[1].args.slice(-2), ['resume', '--last']);
    assert.deepEqual(events[2].args.slice(-2), ['-c', 'model=fixture']);
    assert.ok(events[3].args.includes('-c'));
    for (const name of ['unsnooze-ensure', 'unsnooze-update']) {
      const destination = join(home, 'bin', name); mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(installedBin, name), destination); chmodSync(destination, 0o700);
    }
    await command('bash', [join(home, 'bin/unsnooze-ensure')]); await command('bash', [join(home, 'bin/unsnooze-ensure')]);
    privateFile(join(root, 'HOST-REQUEST'), 'CUTOVER-READY');
    assert.equal(existsSync(join(root, 'HOST-DONE')), false, 'old services cannot be retired before host acknowledgment');
    assert.equal(readFileSync(join(root, 'HOST-REQUEST'), 'utf8'), 'CUTOVER-READY');
    privateFile(join(root, 'HOST-DONE'), 'simulated acknowledgment\n');
  });
  await step('nightly updater enforces origin and runs install only after green verification', async () => {
    const directory = join(root, 'updater'), tools = join(directory, 'tools');
    mkdirSync(tools, { recursive: true, mode: 0o700 });
    const trace = join(directory, 'trace.jsonl');
    const fixture = privateFile(join(directory, 'tool.mjs'), `
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [tool,...args]=process.argv.slice(2);
const env=process.env;
if(tool==='git') {
  if(args[0]==='rev-parse') console.log(${JSON.stringify(join(directory, 'update.lock'))});
  else if(args[0]==='branch') console.log('main');
  else if(args[0]==='status') { if(env.UPDATE_CASE==='dirty') console.log(' M file'); }
  else if(args[0]==='remote') console.log(env.UPDATE_CASE==='origin'?'https://invalid.example/repo':'git@github.com:PulseBeat02/unsnooze.git');
  else if(args[0]!=='pull') throw new Error('Unexpected git invocation');
  if(args[0]!=='pull') process.exit(0);
}
appendFileSync(${JSON.stringify(trace)},JSON.stringify({tool,args})+'\\n',{mode:0o600});
if(tool==='npm') {
  if(env.UPDATE_CASE==='test'&&args[0]==='test') process.exit(7);
  if(env.UPDATE_CASE==='lint'&&args[0]==='run') process.exit(8);
  if(args[0]==='pack') writeFileSync(join(args[args.indexOf('--pack-destination')+1],'verified-fixture.tgz'),'fixture',{mode:0o600});
}
`);
    for (const name of ['git', 'npm']) {
      const path = privateFile(join(tools, name), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} ${name} "$@"\n`);
      chmodSync(path, 0o700);
    }
    for (const scenario of ['origin', 'dirty', 'test', 'lint', 'green']) {
      privateFile(trace, '');
      const env = { ...environment, PATH: `${tools}:${environment.PATH}`, UNSNOOZE_FORK_REPO: directory, UPDATE_CASE: scenario };
      await command('bash', [join(home, 'bin/unsnooze-update')], { env, codes: scenario === 'green' ? [0] : scenario === 'test' ? [7] : scenario === 'lint' ? [8] : [1] });
      const actions = readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
      if (['origin', 'dirty'].includes(scenario)) assert.equal(actions.length, 0);
      if (scenario !== 'green') assert.ok(!actions.some(a => a.args[0] === 'install'));
      else {
        assert.deepEqual(actions.map(a => [a.tool, ...a.args.slice(0, 1)]), [
          ['git', 'pull'], ['npm', 'ci'], ['npm', 'test'], ['npm', 'run'], ['npm', 'pack'], ['npm', 'install'],
        ]);
        assert.ok(actions.at(-1).args.includes('-g'));
        assert.ok(actions.at(-1).args.some(a => a.endsWith('/verified-fixture.tgz')));
      }
    }
  });
  await step('staged failure rollback restores original package, shells and token references', async () => {
    await cli('daemon', 'stop'); assert.equal((await status()).healthy, false);
    for (const [path, before] of originals) {
      copyFileSync(path + backupSuffix, path);
      assert.deepEqual(readFileSync(path), before);
    }
    // Return the original AGY account's latest native-owned token, not a stale
    // credential backup. It may have occupied the slot before another account.
    copyFileSync(accounts().agy.accounts.find(a => a.id === ga).credential.path,
      join(home, '.gemini/antigravity-cli/antigravity-oauth-token'));
    for (const [path, before] of sourceBytes) assert.deepEqual(readFileSync(path), before);
    privateFile(join(root, 'HOST-REQUEST'), 'ROLLBACK');
    for (const name of ['unsnooze-ensure', 'unsnooze-update']) rmSync(join(home, 'bin', name));
    delete environment.NODE_OPTIONS;
    await command('npm', ['install', '-g', '--prefix', prefix, oldArchive, '--no-audit', '--no-fund']);
    installed = false;
    assert.equal((await cli('--version')).stdout.trim(), '1.19.0');
    assert.equal(readFileSync(join(root, 'HOST-REQUEST'), 'utf8'), 'ROLLBACK');
  });
  assert.deepEqual(failures, []);
  assert.ok(readdirSync(root).includes('ISOLATED-VERIFICATION'));
} finally {
  if (installed) await runCli(['daemon', 'stop'], { codes: [0, 1] }).catch(() => {});
  providerServer.closeAllConnections(); await new Promise(r => providerServer.close(r));
  privateFile(join(output, 'e2e.json'), { artifact: artifact.sha256, version: artifact.version, root,
    passed: results.length, checks: results, providerRequests: requests.length, failures });
}
console.log(JSON.stringify({ passed: results.length, providerRequests: requests.length, output }));
