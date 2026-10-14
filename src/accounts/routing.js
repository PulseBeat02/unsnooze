// Account decisions are serialized across processes; the committed active ID
// precedes forwarding. A crash never leaves a half-swapped credential pair.
import { join } from 'node:path';
import { STATE_DIR } from '../config.js';
import { readAccounts, mutateAccounts } from './config.js';
import { chooseAccount } from './select.js';
import { fetchUsageSnapshot } from './usage.js';
import { readPrivateJson, atomicPrivateJson, withStoreLock } from './store.js';
import { scopeUsage } from './scope.js';
import { remoteProvider, remoteSelect } from './remote.js';

const empty = () => ({ version: 1, providers: {} });

export function routingState(stateDir = STATE_DIR) {
  // Corrupt routing state must not silently erase a recorded quota rejection.
  return readPrivateJson(join(stateDir, 'routing-state.json'), empty());
}

export async function recordAccountFailure(provider, id, status, {
  stateDir = STATE_DIR, now = Date.now(), retryAt = null,
} = {}) {
  await withStoreLock(join(stateDir, 'routing-state.json'), async () => {
    const state = routingState(stateDir);
    const p = state.providers[provider] ||= { blocked: {}, lastSwitchAt: 0 };
    p.blocked ||= {};
    p.blocked[id] = { status, observedAt: now, retryAt };
    atomicPrivateJson(join(stateDir, 'routing-state.json'), state);
  });
}

export async function selectRoutingAccount(provider, {
  stateDir = STATE_DIR, reason = 'request', exclude = [], refresh = false,
  now, usageFn = fetchUsageSnapshot, minFetchedAt = 0,
  model, remoteFn = remoteProvider, remoteSelectFn = remoteSelect,
} = {}) {
  const remote = remoteFn(provider, stateDir);
  if (remote) return selectRemoteAccount(provider, remote, { stateDir, reason, exclude, refresh, minFetchedAt, model, remoteSelectFn });
  const snapshot = await usageFn({ stateDir, refresh, allowProbe: provider === 'claude' });
  now ??= Date.now();
  return withStoreLock(join(stateDir, 'routing-state.json'), async () => {
    const config = readAccounts(stateDir);
    const profile = config.providers[provider];
    if (!profile?.accounts.length) return { account: null, reason: 'unconfigured', retryAt: null };
    const state = routingState(stateDir);
    const p = state.providers[provider] ||= { blocked: {}, lastSwitchAt: 0 };
    p.blocked ||= {};
    const usage = {};
    for (const rawEntry of snapshot.providers?.[provider]?.accounts || []) {
      const entry = scopeUsage(provider, rawEntry, model, { now });
      const block = p.blocked[entry.id];
      const live = entry.status === 'ok' && !entry.stale && entry.fetchedAt >= minFetchedAt;
      if (block && live && entry.fetchedAt > block.observedAt) delete p.blocked[entry.id];
      usage[entry.id] = !live || p.blocked[entry.id]
        ? { ...entry, status: p.blocked[entry.id]?.status || (entry.status === 'ok' ? 'unknown' : entry.status) }
        : entry;
    }
    // A rejection belongs to the caller's attempted account. Another session
    // may already have moved the global active ID to a healthy replacement.
    const selectionReason = ['limit', 'quota_exhausted'].includes(reason) && exclude.length
      && !exclude.includes(profile.activeAccountId) ? 'request' : reason;
    const result = chooseAccount(profile, usage, {
      now, reason: selectionReason, exclude, currentId: profile.activeAccountId, lastSwitchAt: p.lastSwitchAt,
    });
    if (result.account && result.account.id !== profile.activeAccountId) {
      await mutateAccounts(latest => {
        const current = latest.providers[provider];
        // A concurrent manual pin/disable always wins over an automatic choice.
        if (JSON.stringify(current) !== JSON.stringify(profile)) return;
        current.activeAccountId = result.account.id;
      }, stateDir);
      if (readAccounts(stateDir).providers[provider].activeAccountId !== result.account.id) {
        return { account: null, reason: 'configuration_changed', retryAt: now + 1000 };
      }
      p.lastSwitchAt = now;
    }
    if (!result.account) {
      const constrainedId = profile.pinnedAccountId
        || (profile.policy.neverSwitch || !profile.policy.onLimit ? profile.activeAccountId : null);
      const statuses = profile.accounts.filter(a => a.enabled && (!constrainedId || a.id === constrainedId))
        .map(a => usage[a.id]?.status);
      result.status = statuses.length && statuses.every(s => s === 'quota_exhausted') ? 'quota_exhausted'
        : statuses.includes('expired_login') ? 'expired_login'
          : statuses.includes('network_error') ? 'network_error' : 'unknown';
    }
    atomicPrivateJson(join(stateDir, 'routing-state.json'), state);
    return result;
  });
}

// The host decides with its own usage evidence and routing state. Callers get
// the local mirror of the chosen account (metadata and a "remote" reference).
// An unreachable host holds sessions exactly like an unverifiable quota.
async function selectRemoteAccount(provider, remote, { stateDir, reason, exclude, refresh, minFetchedAt, model, remoteSelectFn }) {
  let reply;
  try { reply = await remoteSelectFn(remote, provider, { reason, exclude, refresh, minFetchedAt, model }); }
  catch { return { account: null, reason: 'remote_unavailable', status: 'network_error', retryAt: Date.now() + 30_000 }; }
  const chosen = reply.account && typeof reply.account.id === 'string' ? reply.account : null;
  let account = null;
  if (chosen) {
    let local = null;
    try { local = readAccounts(stateDir).providers[provider]?.accounts.find(a => a.id === chosen.id) ?? null; }
    catch { /* a damaged mirror still routes by the host's answer */ }
    account = local ?? { id: chosen.id, name: chosen.name, enabled: chosen.enabled !== false,
      priority: Number.isSafeInteger(chosen.priority) ? chosen.priority : 0,
      credential: { type: 'remote', path: remote.socket } };
  }
  return { account, reason: typeof reply.reason === 'string' ? reply.reason : undefined,
    retryAt: Number.isFinite(reply.retryAt) ? reply.retryAt : null,
    ...(typeof reply.status === 'string' ? { status: reply.status } : {}) };
}
