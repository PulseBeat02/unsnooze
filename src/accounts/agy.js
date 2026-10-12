// Antigravity owns its OAuth client and refresh operation. Never extract its
// client secret: serialize native CLI lifetimes around its credential file.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { STATE_DIR } from '../config.js';
import { readAccounts, mutateAccounts } from './config.js';
import { readPrivateJson, atomicPrivateJson, withStoreLock } from './store.js';
import { selectRoutingAccount } from './routing.js';

export function agyResumeArgs(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId || /[\x00-\x1f\x7f]/.test(sessionId)) {
    throw new Error('A known conversation is required to switch Antigravity accounts.');
  }
  return ['--conversation', sessionId];
}

export function installAgyCredential(account, nativePath) {
  if (account.credential.type !== 'agy-token') throw new Error('Antigravity needs its native token file.');
  if (resolve(account.credential.path) === resolve(nativePath)) return;
  const data = readPrivateJson(account.credential.path);
  if (typeof data?.token?.access_token !== 'string') throw new Error('Invalid Antigravity credential.');
  atomicPrivateJson(nativePath, data);
}

export function saveAgyCredential(account, nativePath) {
  if (resolve(account.credential.path) === resolve(nativePath)) return;
  const data = readPrivateJson(nativePath);
  if (typeof data?.token?.access_token !== 'string') throw new Error('Invalid refreshed Antigravity credential.');
  atomicPrivateJson(account.credential.path, data);
}

export async function runManagedAgy(args, { stateDir = STATE_DIR, launchFn = null,
  nativePath = join(homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
  selectFn = selectRoutingAccount, readStateFn = null, intervalMs = 5000,
} = {}) {
  if (!launchFn) {
    const { getMultiplexer } = await import('../multiplexer.js');
    const mux = getMultiplexer();
    if (!mux.inside() && mux.available() && !args.some(x => ['-p', '--print'].includes(x))) {
      return (await import('../launcher.js')).runLauncher(args, 'agy');
    }
  }
  const profile = readAccounts(stateDir).providers.agy;
  if (!profile?.accounts.some(a => a.enabled)) throw new Error('No enabled Antigravity account.');
  // One native credential consumer at a time. Other providers and their
  // sessions remain concurrent; a second agy launch waits without refreshing.
  return withStoreLock(join(stateDir, 'agy-native-session'), async () => {
    // Detach the native slot before switching away, otherwise overwriting that
    // slot would also overwrite the first account's only stored reference.
    await mutateAccounts(config => {
      for (const item of config.providers.agy.accounts) {
        if (resolve(item.credential.path) !== resolve(nativePath)) continue;
        const savedPath = join(stateDir, 'credentials', `agy-${item.id}.json`);
        atomicPrivateJson(savedPath, readPrivateJson(nativePath));
        item.credential = { type: 'agy-token', path: savedPath };
      }
    }, stateDir);
    const currentProfile = readAccounts(stateDir).providers.agy;
    const run = launchFn || (await import('../launcher.js')).runLauncher;
    const read = readStateFn || (await import('../state.js')).readState;
    let chosen = await selectFn('agy', { stateDir });
    // An expired access token is handed to agy, which can refresh its own login.
    // It is never treated as quota exhaustion or refreshed by unsnooze.
    let account = chosen.account || currentProfile.accounts.find(a => a.enabled
      && a.id === (currentProfile.pinnedAccountId || currentProfile.activeAccountId)) || currentProfile.accounts.find(a => a.enabled);
    let nextArgs = args;
    for (;;) {
      installAgyCredential(account, nativePath);
      let child = null, lease = null, switching = null, checking = false;
      const check = async () => {
        if (!lease || !child || switching || checking) return;
        checking = true;
        try {
          saveAgyCredential(account, nativePath);
          const stopped = Object.values(read().sessions || {}).find(s => s.agent === 'agy'
            && s.leaseId === lease.leaseId && s.status === 'stopped' && s.sessionId);
          if (!stopped) return;
          const next = await selectFn('agy', { stateDir, reason: 'limit', refresh: true,
            exclude: [account.id], minFetchedAt: stopped.detectedAt || 0 });
          if (!next.account || next.account.id === account.id) return;
          switching = { account: next.account, sessionId: stopped.sessionId };
          atomicPrivateJson(join(stateDir, 'agy-switch.json'), { version: 1,
            sessionId: stopped.sessionId, key: stopped.key, cwd: stopped.cwd,
            from: account.id, to: next.account.id, at: Date.now(), phase: 'selected' });
          child.kill('SIGTERM');
        } finally { checking = false; }
      };
      const timer = setInterval(() => { check().catch(() => {}); }, intervalMs);
      timer.unref();
      let code;
      try { code = await run(nextArgs, 'agy', { onChild: (p, l) => { child = p; lease = l; } }); }
      finally {
        clearInterval(timer);
        // Only the native CLI ever refreshes; preserve its latest token before
        // another account is installed. Writes are atomic and owner-only.
        saveAgyCredential(account, nativePath);
      }
      if (!switching) return code;
      account = switching.account;
      nextArgs = agyResumeArgs(switching.sessionId);
      atomicPrivateJson(join(stateDir, 'agy-switch.json'), { version: 1,
        sessionId: switching.sessionId, to: account.id, at: Date.now(), phase: 'resuming' });
    }
  });
}
