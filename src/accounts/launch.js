import { STATE_DIR } from '../config.js';
import { hasAccounts } from './config.js';
import { ensureAccountDaemon } from './daemon.js';
import { routerToken } from './proxy.js';

export function managedLaunchOptions(provider, args, { port, token, env = process.env } = {}) {
  const nextEnv = { ...env };
  const base = `http://127.0.0.1:${port}`;
  if (provider === 'claude') {
    nextEnv.ANTHROPIC_BASE_URL = `${base}/claude`;
    nextEnv.CLAUDE_CODE_OAUTH_TOKEN = token;
    delete nextEnv.ANTHROPIC_API_KEY;
    delete nextEnv.ANTHROPIC_AUTH_TOKEN;
  } else if (provider === 'codex') {
    // The CLI gets only a local capability. Provider OAuth credentials never
    // enter its auth.json, environment, argv or refresh code path.
    nextEnv.UNSNOOZE_ROUTER_TOKEN = token;
    nextEnv.UNSNOOZE_CODEX_BIN = env.UNSNOOZE_CODEX_DIRECT_BIN || 'codex';
    args = ['-c', 'model_provider="unsnooze"',
      '-c', 'model_providers.unsnooze.name="unsnooze"',
      '-c', `model_providers.unsnooze.base_url="${base}/codex"`,
      '-c', 'model_providers.unsnooze.wire_api="responses"',
      '-c', 'model_providers.unsnooze.requires_openai_auth=false',
      '-c', 'model_providers.unsnooze.env_key="UNSNOOZE_ROUTER_TOKEN"',
      '-c', 'model_providers.unsnooze.supports_websockets=false', ...args];
  }
  return { args, env: nextEnv };
}

export async function runAccountLaunch(provider, args, {
  stateDir = STATE_DIR, ensureFn = ensureAccountDaemon, launchFn = null,
} = {}) {
  if (!['claude', 'codex', 'agy'].includes(provider)
    || args.some(x => ['--help', '-h', '--version', '-V', '-v'].includes(x))
    || !hasAccounts(provider, stateDir)) return null;
  try {
    const status = await ensureFn({ stateDir });
    if (!status.healthy) throw new Error('Router unavailable.');
    if (provider === 'agy') {
      const { runManagedAgy } = await import('./agy.js');
      return await runManagedAgy(args, { stateDir, launchFn });
    }
    const options = managedLaunchOptions(provider, args, { port: status.port, token: routerToken(stateDir) });
    Object.assign(process.env, options.env);
    if (provider === 'claude') {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
    // Import only after the direct Codex binary override is installed; adapter
    // modules resolve their bin once. This avoids the old mcodex router.
    const run = launchFn || (await import('../launcher.js')).runLauncher;
    return await run(options.args, provider, provider === 'codex'
      ? { binOverride: process.env.UNSNOOZE_CODEX_DIRECT_BIN || 'codex' } : {});
  } catch {
    process.stderr.write('unsnooze: managed account launch unavailable; check daemon status and usage.\n');
    return 1;
  }
}
