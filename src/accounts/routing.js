// Account decisions are serialized across processes; the committed active ID
// precedes forwarding. A crash never leaves a half-swapped credential pair.
import { join } from 'node:path';
import { STATE_DIR } from '../config.js';
import { readAccounts, mutateAccounts } from './config.js';
import { chooseAccount } from './select.js';
import { fetchUsageSnapshot } from './usage.js';
import { readPrivateJson, atomicPrivateJson, withStoreLock } from './store.js';
import { scopeUsage } from './scope.js';

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
  model,
} = {}) {
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
    const result = chooseAccount(profile, usage, {
      now, reason, exclude, currentId: profile.activeAccountId, lastSwitchAt: p.lastSwitchAt,
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
    atomicPrivateJson(join(stateDir, 'routing-state.json'), state);
    return result;
  });
}
