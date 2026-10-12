// Account evidence only advances the existing resumer's clock. It never
// dispatches into a pane or replaces a session's workspace/lease identity.

import { chooseAccount } from './select.js';

const FRESH_MS = 60_000;

export function availableAccountEvidence(provider, usage, {
  now = Date.now(), maxAgeMs = FRESH_MS,
} = {}) {
  if (!provider || !Array.isArray(provider.accounts)) return [];
  const threshold = provider.policy?.thresholdPercent ?? 95;
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 100) return [];
  const measured = new Map((usage?.accounts ?? []).map(account => [account.id, account]));
  const selected = chooseAccount(provider, measured, { now }).account;
  if (!selected) return [];
  return (usage?.accounts ?? []).filter(account => {
    if (selected.id !== account.id
      || account.enabled === false || account.status !== 'ok' || account.stale !== false
      || !Number.isFinite(account.fetchedAt) || account.fetchedAt > now + 5_000
      || now - account.fetchedAt > maxAgeMs
      || !Array.isArray(account.windows) || account.windows.length === 0) return false;
    return account.windows.every(window => Number.isFinite(window.usedPercent)
      && window.usedPercent >= 0 && window.usedPercent < 100);
  });
}

// Pure decision function. The returned patch changes scheduling only. Call it
// inside updateState so a new stop cannot be cleared by an older state snapshot.
export function reconciliationPatches(state, accounts, snapshot, {
  now = Date.now(), maxAgeMs = FRESH_MS,
} = {}) {
  const evidence = new Map(Object.entries(accounts?.providers ?? {}).map(([agent, provider]) =>
    [agent, availableAccountEvidence(provider, snapshot?.providers?.[agent], { now, maxAgeMs })]));
  const patches = [];
  for (const [key, rec] of Object.entries(state?.sessions ?? {})) {
    if (rec.status !== 'stopped' || !Number.isFinite(rec.resetAt) || rec.resetAt <= now) continue;
    const stoppedAt = rec.bannerAt ?? rec.detectedAt;
    if (!Number.isFinite(stoppedAt)) continue;
    const ready = evidence.get(rec.agent ?? 'claude') ?? [];
    if (!ready.some(account => account.fetchedAt >= stoppedAt)) continue;
    patches.push({ key, resetAt: now, resetSource: 'account-usage', usageReconciledAt: now });
  }
  return patches;
}

export async function reconcileAccountSessions({
  stateDir,
  now,
  maxAgeMs = FRESH_MS,
  accounts,
  snapshot,
  readAccounts,
  fetchUsageSnapshot,
  updateState,
} = {}) {
  if (!readAccounts && !accounts) ({ readAccounts } = await import('./config.js'));
  if (!fetchUsageSnapshot && !snapshot) ({ fetchUsageSnapshot } = await import('./usage.js'));
  if (!updateState) {
    const config = await import('../config.js');
    const { resolve } = await import('node:path');
    if (stateDir && resolve(stateDir) !== resolve(config.STATE_DIR)) {
      throw new Error('Account reconciliation must use the upstream process state directory');
    }
    ({ updateState } = await import('../state.js'));
  }
  accounts ??= readAccounts(stateDir);
  // A failed refresh stays failed. Cached windows alone never wake sessions.
  snapshot ??= await fetchUsageSnapshot({ stateDir, refresh: true, allowProbe: false });
  const checkedAt = now ?? Date.now();
  let changed = [];
  await updateState(state => {
    changed = reconciliationPatches(state, accounts, snapshot, { now: checkedAt, maxAgeMs });
    for (const { key, ...patch } of changed) Object.assign(state.sessions[key], patch);
    return state;
  });
  return { changed: changed.map(patch => patch.key), snapshot };
}
