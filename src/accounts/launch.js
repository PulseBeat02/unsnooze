import { STATE_DIR } from '../config.js';
import { readAccounts } from './config.js';
import { ensureAccountDaemon } from './daemon.js';
import { routerToken } from './proxy.js';
import { randomUUID } from 'node:crypto';
import { runRoutedConversation } from './sessions.js';

export function managedLaunchOptions(provider, args, { port, token, env = process.env, launchId } = {}) {
  const nextEnv = { ...env };
  const base = `http://127.0.0.1:${port}`;
  if (provider === 'claude') {
    nextEnv.ANTHROPIC_BASE_URL = `${base}/claude`;
    nextEnv.CLAUDE_CODE_OAUTH_TOKEN = token;
    delete nextEnv.ANTHROPIC_API_KEY;
    delete nextEnv.ANTHROPIC_AUTH_TOKEN;
    if (launchId) nextEnv.ANTHROPIC_CUSTOM_HEADERS = [
      ...(env.ANTHROPIC_CUSTOM_HEADERS || '').split('\n').filter(h => !/^x-unsnooze-launch:/i.test(h)),
      `x-unsnooze-launch: ${launchId}`,
    ].filter(Boolean).join('\n');
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
      ...(launchId ? ['-c', `model_providers.unsnooze.http_headers={"x-unsnooze-launch"="${launchId}"}`] : []),
      '-c', 'model_providers.unsnooze.supports_websockets=false', ...args];
  }
  return { args, env: nextEnv };
}

export async function runAccountLaunch(provider, args, {
  stateDir = STATE_DIR, ensureFn = ensureAccountDaemon, launchFn = null,
} = {}) {
  if (!['claude', 'codex', 'agy'].includes(provider)
    || args.some(x => ['--help', '-h', '--version', '-V', '-v'].includes(x))
    || !readAccounts(stateDir).providers[provider]?.accounts.length) return null;
  try {
    // Re-exec into the multiplexer before applying per-launch credentials and
    // header identities. Otherwise the inner wrapper inherits an outer ID.
    if (!launchFn && !args.some(x => ['-p', '--print'].includes(x))) {
      const { getMultiplexer } = await import('../multiplexer.js');
      const mux = getMultiplexer();
      if (!mux.inside() && mux.available()) {
        return (await import('../launcher.js')).runLauncher(args, provider, { forceWatch: true });
      }
    }
    const status = await ensureFn({ stateDir });
    if (!status.healthy) throw new Error('Router unavailable.');
    if (provider === 'agy') {
      const { runManagedAgy } = await import('./agy.js');
      return await runManagedAgy(args, { stateDir, launchFn });
    }
    const launchId = randomUUID();
    const options = managedLaunchOptions(provider, args, { port: status.port, token: routerToken(stateDir), launchId });
    Object.assign(process.env, options.env);
    if (provider === 'claude') {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
    // Import only after the direct Codex binary override is installed; adapter
    // modules resolve their bin once. This avoids the old mcodex router.
    const run = launchFn || (await import('../launcher.js')).runLauncher;
    return await runRoutedConversation(provider, args, { stateDir, launchId, run,
      buildOptions: next => ({ ...managedLaunchOptions(provider, next, {
        port: status.port, token: routerToken(stateDir), launchId,
      }), bin: provider === 'codex' ? process.env.UNSNOOZE_CODEX_DIRECT_BIN || 'codex' : null }),
    });
  } catch {
    process.stderr.write('unsnooze: managed account launch unavailable; check daemon status and usage.\n');
    return 1;
  }
}
