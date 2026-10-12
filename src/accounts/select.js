import { ACCOUNT_USAGE_MAX_AGE_MS, DEFAULT_POLICY } from './config.js';

const finiteTime = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function inspect(usage, now, threshold) {
  if (!usage || typeof usage !== 'object') return { state: 'unknown', retryAt: null };
  const windows = Array.isArray(usage.windows) ? usage.windows : [];
  const resets = windows.map(w => w?.resetAt).filter(finiteTime);
  const retryAt = resets.length ? Math.max(now, Math.min(...resets)) : null;
  // Quota remains exhausted after resetAt. Only a subsequent live successful
  // fetch may replace this status; a clock tick alone never restores quota.
  if (usage.status === 'quota_exhausted') return { state: 'quota_exhausted', retryAt };
  if (usage.status !== 'ok') return { state: ['expired_login', 'network_error'].includes(usage.status) ? usage.status : 'unknown', retryAt: null };
  if (usage.stale === true || !finiteTime(usage.fetchedAt) || usage.fetchedAt > now || now - usage.fetchedAt > ACCOUNT_USAGE_MAX_AGE_MS) {
    return { state: 'stale', retryAt: now };
  }
  if (!windows.length || windows.some(w => !w || typeof w.id !== 'string' || !w.id
      || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100
      || (w.resetAt != null && !finiteTime(w.resetAt)))) return { state: 'unknown', retryAt: null };
  const used = Math.max(...windows.map(w => w.usedPercent));
  if (used >= 100) return { state: 'quota_exhausted', retryAt, used };
  if (used >= threshold) return { state: 'threshold', retryAt, used };
  return { state: 'available', used, retryAt: null };
}

function nextProbe(observations, now) {
  const resets = observations.map(o => o.retryAt).filter(finiteTime);
  return resets.length ? Math.max(now, Math.min(...resets)) : null;
}

/**
 * Pure routing decision. Usage timestamps and resetAt are milliseconds since
 * epoch. A successful measurement must be at most 60 seconds old and contain
 * at least one valid quota window. Higher numeric priority wins ties.
 *
 * `reason: 'quota_exhausted'` represents a live request reporting a limit;
 * it disqualifies the current account even if the cached sample predates it.
 * `exclude` also prevents retrying accounts already attempted by a caller.
 * Neither an auth failure nor an unavailable measurement triggers failover.
 */
export function chooseAccount(providerConfig, usageMap = {}, {
  now = Date.now(), reason = 'request', currentId = providerConfig?.activeAccountId ?? null,
  lastSwitchAt = null, exclude = [],
} = {}) {
  const result = (account, why, retryAt = null) => ({ account, reason: why, retryAt });
  if (!providerConfig || !Array.isArray(providerConfig.accounts) || !finiteTime(now)) return result(null, 'invalid_config');
  const policy = { ...DEFAULT_POLICY, ...providerConfig.policy };
  const excluded = new Set(exclude);
  const getUsage = id => usageMap instanceof Map ? usageMap.get(id) : usageMap && Object.hasOwn(usageMap, id) ? usageMap[id] : undefined;
  const accounts = providerConfig.accounts.filter(a => a && a.enabled === true);
  const observations = new Map(accounts.map(a => [a.id, inspect(getUsage(a.id), now, policy.thresholdPercent)]));
  const current = accounts.find(a => a.id === currentId) ?? null;
  const currentUsage = current ? observations.get(current.id) : null;
  const liveLimit = reason === 'quota_exhausted' || reason === 'limit';
  const limited = liveLimit || currentUsage?.state === 'quota_exhausted';
  if (liveLimit && current) {
    observations.set(current.id, { ...currentUsage, state: 'quota_exhausted' });
    excluded.add(current.id);
  }
  const available = a => !excluded.has(a.id) && observations.get(a.id)?.state === 'available';
  const usable = a => !excluded.has(a.id) && ['available', 'threshold'].includes(observations.get(a.id)?.state);

  if (providerConfig.pinnedAccountId) {
    const pin = accounts.find(a => a.id === providerConfig.pinnedAccountId);
    if (pin && usable(pin)) return result(pin, 'pinned');
    return result(null, 'pinned_unavailable', nextProbe(pin ? [observations.get(pin.id)] : [], now));
  }
  if (policy.neverSwitch) {
    if (current && usable(current)) return result(current, 'never_switch');
    return result(null, 'never_switch', nextProbe(current ? [observations.get(current.id)] : [], now));
  }
  if (limited && !policy.onLimit) return result(null, 'on_limit_disabled', nextProbe([...observations.values()], now));

  // Avoid classifying an auth or transport failure as a quota signal. An
  // explicit live quota response is allowed to supersede cached status.
  if (current && !limited && !excluded.has(current.id)
      && ['unknown', 'expired_login', 'network_error', 'stale'].includes(currentUsage.state)) {
    return result(null, currentUsage.state, currentUsage.retryAt);
  }
  if (current && available(current)) return result(current, 'current');
  const cooldownUntil = finiteTime(lastSwitchAt) ? lastSwitchAt + policy.cooldownMs : null;
  if (!limited && currentId && cooldownUntil !== null && now < cooldownUntil) return result(current && usable(current) ? current : null, 'cooldown', cooldownUntil);

  let candidates = accounts.filter(available);
  if (!candidates.length) {
    if (current && usable(current)) return result(current, 'current');
    // Threshold is a preferred switching point, not a second quota cap.
    // When the current account is exhausted, remaining real headroom is
    // still usable even if every replacement is above the preference.
    candidates = accounts.filter(usable);
  }
  if (!candidates.length) {
    const observed = [...observations.values()];
    const allExhausted = observed.length > 0 && observed.every(o => o.state === 'quota_exhausted');
    return result(null, allExhausted ? 'all_exhausted' : 'no_available_account', nextProbe([...observations.values()], now));
  }
  const order = new Map(accounts.map((a, i) => [a.id, i]));
  const currentIndex = order.get(currentId) ?? -1;
  candidates.sort((a, b) => {
    if (policy.strategy === 'round-robin') {
      const distance = id => (order.get(id) - currentIndex - 1 + accounts.length) % accounts.length;
      return distance(a.id) - distance(b.id);
    }
    const headroom = observations.get(a.id).used - observations.get(b.id).used;
    const priority = b.priority - a.priority;
    return (policy.strategy === 'priority' ? priority || headroom : headroom || priority)
      || order.get(a.id) - order.get(b.id);
  });
  return result(candidates[0], currentId ? (limited ? 'quota_exhausted' : 'threshold') : 'initial');
}
