// The native CLI is Antigravity's only OAuth refresh owner. A durable slot
// journal and inherited process nonce keep a dead wrapper from freeing a live CLI.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { STATE_DIR } from '../config.js';
import { readAccounts, mutateAccounts } from './config.js';
import { readPrivateJson, atomicPrivateJson, withStoreLock } from './store.js';
import { readCredential } from './credentials.js';
import { selectRoutingAccount } from './routing.js';
import { accountProcessBirth } from './daemon.js';

export function agyResumeArgs(sessionId) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(sessionId)) {
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

export function readAgyJournal(stateDir = STATE_DIR) {
  const journal = readPrivateJson(join(stateDir, 'agy-native-session.json'), null);
  if (!journal) return null;
  if (journal.version !== 1 || !['installing', 'prepared', 'running', 'switching', 'complete'].includes(journal.phase)
    || !/^[a-f0-9-]{36}$/.test(journal.launchNonce) || !journal.account?.credential) {
    throw new Error('Antigravity ownership state is invalid.');
  }
  return journal;
}

export function agyOwnerAlive(journal, { platform = process.platform, procRoot = '/proc',
  birthFn = accountProcessBirth, readFile = readFileSync, readdir = readdirSync, stat = statSync,
} = {}) {
  if (!journal || journal.phase === 'complete' || journal.phase === 'installing') return false;
  if (journal.child?.pid) {
    const birth = birthFn(journal.child.pid);
    if (birth && (!journal.child.pidBirth || birth === journal.child.pidBirth)) return true;
  }
  // A parent may die between spawn and PID publication. The nonce was saved
  // BEFORE spawn and inherited by both the native process and its descendants.
  if (platform !== 'linux') return !journal.child;
  const marker = `UNSNOOZE_AGY_LAUNCH_NONCE=${journal.launchNonce}`;
  for (const name of readdir(procRoot)) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    const directory = join(procRoot, name);
    try {
      if (typeof process.getuid === 'function' && stat(directory).uid !== process.getuid()) continue;
      const info = readFile(join(directory, 'stat'), 'utf8');
      if (info.slice(info.lastIndexOf(')') + 2).startsWith('Z ')) continue;
      if (readFile(join(directory, 'environ'), 'utf8').split('\0').includes(marker)) return true;
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) return true;
    }
  }
  return false;
}

export function recoverAgySlot(journal, nativePath, { aliveFn = agyOwnerAlive } = {}) {
  if (!journal || journal.phase === 'complete') return;
  if (aliveFn(journal)) throw new Error('An Antigravity credential owner is still running.');
  // 'installing' may mean the new token has not reached the slot yet. No child
  // can have started then; never copy that ambiguous slot into an account.
  if (journal.phase !== 'installing') saveAgyCredential(journal.account, nativePath);
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1);
}

export async function runManagedAgy(args, { stateDir = STATE_DIR, launchFn = null,
  nativePath = join(homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
  selectFn = selectRoutingAccount, readStateFn = null, updateStateFn = null,
  ownerAliveFn = agyOwnerAlive, intervalMs = 5000,
} = {}) {
  const profile = readAccounts(stateDir).providers.agy;
  if (!profile?.accounts.some(a => a.enabled)) throw new Error('No enabled Antigravity account.');
  return withStoreLock(join(stateDir, 'agy-native-session'), async () => {
    const journalPath = join(stateDir, 'agy-native-session.json');
    const prior = readAgyJournal(stateDir);
    recoverAgySlot(prior, nativePath, { aliveFn: ownerAliveFn });
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
    const update = updateStateFn || (await import('../state.js')).updateState;
    const model = option(args, '--model');
    const chosen = await selectFn('agy', { stateDir, model, refresh: true });
    let account = chosen.account;
    if (!account && ['expired_login', 'pinned_unavailable', 'never_switch'].includes(chosen.reason)) {
      const candidate = currentProfile.accounts.find(a => a.enabled
        && a.id === (currentProfile.pinnedAccountId || currentProfile.activeAccountId));
      if (candidate && readCredential(candidate).expiresAt < Date.now()) account = candidate;
    }
    if (!account) throw new Error('Antigravity quota is unavailable; no native session was started.');
    let nextArgs = args, resumeTarget = null;
    for (;;) {
      const launchNonce = randomUUID();
      let journal = { version: 1, phase: 'installing', launchNonce,
        account: { id: account.id, credential: account.credential }, cwd: process.cwd(),
        wrapperPid: process.pid, wrapperBirth: accountProcessBirth(process.pid),
        sessionId: resumeTarget?.sessionId || option(nextArgs, '--conversation') || null, child: null,
        target: resumeTarget, updatedAt: Date.now() };
      atomicPrivateJson(journalPath, journal);
      installAgyCredential(account, nativePath);
      journal.phase = 'prepared'; atomicPrivateJson(journalPath, journal);
      let child = null, lease = null, switching = null, inFlight = null, ended = false;
      const check = async () => {
        if (!lease || !child || switching || ended) return;
        saveAgyCredential(account, nativePath);
        const stopped = Object.values(read().sessions || {}).find(s => s.agent === 'agy'
          && s.leaseId === lease.leaseId && s.status === 'stopped' && s.sessionId);
        if (!stopped) return;
        const next = await selectFn('agy', { stateDir, model, reason: 'limit', refresh: true,
          exclude: [account.id], minFetchedAt: stopped.detectedAt || 0 });
        if (ended || !next.account || next.account.id === account.id) return;
        switching = { account: next.account, sessionId: stopped.sessionId, key: stopped.key, detectedAt: stopped.detectedAt };
        journal = { ...journal, phase: 'switching', target: { accountId: next.account.id,
          sessionId: stopped.sessionId, key: stopped.key, detectedAt: stopped.detectedAt } };
        atomicPrivateJson(journalPath, journal);
        child.kill('SIGTERM');
      };
      const timer = setInterval(() => {
        if (!inFlight) inFlight = check().catch(() => {}).finally(() => { inFlight = null; });
      }, intervalMs);
      timer.unref();
      let code;
      try {
        code = await run(nextArgs, 'agy', { forceWatch: true,
          childEnv: { UNSNOOZE_AGY_LAUNCH_NONCE: launchNonce },
          onChild: (p, metadata) => {
            child = p; lease = metadata;
            journal = { ...journal, phase: 'running', child: metadata };
            try {
              atomicPrivateJson(journalPath, journal);
              if (resumeTarget?.key) update(state => {
                const record = state.sessions[resumeTarget.key];
                if (record?.sessionId !== resumeTarget.sessionId || record.detectedAt !== resumeTarget.detectedAt) return state;
                Object.assign(record, { status: 'resuming', leaseId: metadata.leaseId,
                  pane: metadata.pane, paneOwner: metadata.paneOwner, mux: metadata.mux,
                  lastAttemptAt: Date.now(), resumeEpisodeAt: record.detectedAt, verifyRetries: 0 });
                return state;
              });
            } catch (error) { child.kill('SIGTERM'); throw error; }
          },
        });
      } finally {
        ended = true; clearInterval(timer);
        if (inFlight) await inFlight;
        saveAgyCredential(account, nativePath);
        if (!ownerAliveFn(journal)) {
          journal.phase = 'complete'; atomicPrivateJson(journalPath, journal);
        }
      }
      if (!switching) return code;
      if (ownerAliveFn(journal)) throw new Error('Antigravity still owns its credential slot.');
      account = switching.account;
      resumeTarget = switching;
      const message = 'Continue where you left off in this same conversation after the account switch.';
      nextArgs = [...(model ? ['--model', model] : []), ...agyResumeArgs(switching.sessionId),
        args.some(a => ['-p', '--print'].includes(a)) ? '--print' : '--prompt-interactive', message];
    }
  });
}
