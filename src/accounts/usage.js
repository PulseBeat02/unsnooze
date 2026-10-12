import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { STATE_DIR } from '../config.js';
import { readAccounts, PROVIDERS } from './config.js';
import { readPrivateJson, atomicPrivateJson, withStoreLock } from './store.js';
import { readCredential, CredentialError } from './credentials.js';
import { fetchAccountUsage, usageFailureMessage, usageFromHeaders } from './providers.js';

export const USAGE_CACHE_TTL_MS = 60_000;
const STATUSES = new Set(['ok', 'quota_exhausted', 'expired_login', 'network_error', 'unknown']);
const SOURCES = new Set(['claude-oauth', 'claude-probe', 'claude-headers', 'codex-usage', 'codex-headers', 'agy-quota', 'unavailable']);
const CODES = new Set(['expired_login', 'permission_denied', 'network_error', 'timeout', 'rate_limited',
  'unavailable', 'malformed', 'stale_data', 'invalid_credential', 'credential_unavailable', 'disabled', 'unsupported']);
const activeFetches = new Map();
const empty = () => ({ version: 1, fetchedAt: null, providers: {} });
const cachePath = stateDir => join(stateDir, 'account-usage.json');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeText = value => typeof value === 'string'
  ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 128) : '';
const timestamp = value => Number.isFinite(value) && value > 0 ? value : null;

function readRawCache(stateDir) {
  try {
    const data = readPrivateJson(cachePath(stateDir), empty());
    return data?.version === 1 && object(data.providers) ? data : empty();
  } catch { return empty(); }
}

function referenceKey(account) {
  const ref = account.credential;
  // Detect edits to a reference without exposing its path or selector in the
  // public snapshot. Tokens never participate in cache metadata.
  return createHash('sha256').update(JSON.stringify([ref.type, ref.path, ref.recordId ?? null])).digest('hex');
}

function sanitizeAccount(account, now, maxAgeMs) {
  if (!object(account) || !safeText(account.id)) return null;
  const fetchedAt = timestamp(account.fetchedAt);
  const checkedAt = timestamp(account.checkedAt) ?? fetchedAt;
  const status = STATUSES.has(account.status) ? account.status : 'unknown';
  const windows = [];
  let malformed = !Array.isArray(account.windows);
  for (const w of Array.isArray(account.windows) ? account.windows : []) {
    if (!object(w) || !safeText(w.id) || !safeText(w.label)
      || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100
      || (w.resetAt !== null && timestamp(w.resetAt) === null)) {
      malformed = true;
      continue;
    }
    windows.push({ id: safeText(w.id), label: safeText(w.label),
      ...(safeText(w.group) ? { group: safeText(w.group) } : {}),
      usedPercent: w.usedPercent, resetAt: w.resetAt,
      ...(w.fetchedAt !== undefined ? { fetchedAt: timestamp(w.fetchedAt) } : {}) });
  }
  const stale = account.stale === true || malformed || !windows.length
    || !['ok', 'quota_exhausted'].includes(status) || fetchedAt === null
    || fetchedAt > now || now - fetchedAt >= maxAgeMs
    || windows.some(w => (w.resetAt !== null && w.resetAt <= now)
      || (w.fetchedAt !== undefined && (w.fetchedAt === null || w.fetchedAt > now || now - w.fetchedAt >= maxAgeMs)));
  const code = CODES.has(account.code) ? account.code : undefined;
  return { id: safeText(account.id), name: safeText(account.name) || safeText(account.id),
    enabled: account.enabled !== false, status: malformed ? 'unknown' : status,
    source: SOURCES.has(account.source) ? account.source : 'unavailable', fetchedAt, checkedAt,
    stale, windows, ...(code ? { code, message: usageFailureMessage(code) } : {}) };
}

function quotaWindowKey(window) {
  // Claude's usage endpoint and response headers use different field names
  // for the same quota. Merge by identity, never by percentage or reset time.
  const aliases = { five_hour: '5h', seven_day: '7d', seven_day_opus: '7d-opus', seven_day_sonnet: '7d-sonnet' };
  return aliases[window.id] ?? window.id;
}

function mergeHeaderObservation(usage, previous, now) {
  if (!previous?.windows?.length || !['claude-headers', 'claude-probe', 'codex-headers'].includes(usage.source)) return usage;
  const windows = usage.windows.map(w => ({ ...w, fetchedAt: usage.fetchedAt }));
  const observed = new Set(windows.map(quotaWindowKey));
  for (const old of previous.windows) {
    if (!observed.has(quotaWindowKey(old))) {
      windows.push({ ...old, fetchedAt: old.fetchedAt ?? previous.fetchedAt });
    }
  }
  const times = windows.map(w => w.fetchedAt);
  const fetchedAt = times.every(t => timestamp(t) !== null) ? Math.min(...times) : null;
  const stale = fetchedAt === null || fetchedAt > now || now - fetchedAt >= USAGE_CACHE_TTL_MS
    || windows.some(w => w.resetAt !== null && w.resetAt <= now);
  return { ...usage, windows, fetchedAt, stale,
    status: windows.some(w => w.usedPercent >= 100) ? 'quota_exhausted' : usage.status };
}

function sanitizeSnapshot(data, now, maxAgeMs) {
  const providers = {};
  for (const provider of PROVIDERS) {
    const section = data.providers[provider];
    if (!Array.isArray(section?.accounts)) continue;
    providers[provider] = { accounts: section.accounts
      .map(account => sanitizeAccount(account, now, maxAgeMs)).filter(Boolean) };
  }
  return { version: 1, fetchedAt: timestamp(data.fetchedAt), providers };
}

// A read never fetches, refreshes credentials, or repairs an external file.
export function readUsageCache({ stateDir = STATE_DIR, now = Date.now(), maxAgeMs = USAGE_CACHE_TTL_MS } = {}) {
  return sanitizeSnapshot(readRawCache(stateDir), now, maxAgeMs);
}

async function collectSnapshot({ stateDir, refresh, fetchFn, now, timeoutMs, allowProbe, endpoints }) {
  const config = readAccounts(stateDir);
  const rawCache = readRawCache(stateDir);
  const cache = sanitizeSnapshot(rawCache, now, USAGE_CACHE_TTL_MS);
  const snapshot = { version: 1, fetchedAt: now, providers: {} };
  const referenceKeys = {};
  let fetched = false;
  await Promise.all(PROVIDERS.map(async provider => {
    const accounts = config.providers[provider]?.accounts || [];
    if (!accounts.length) return;
    referenceKeys[provider] = {};
    snapshot.providers[provider] = { accounts: await Promise.all(accounts.map(async account => {
      const metadata = { id: account.id, name: account.name, enabled: account.enabled };
      const key = referenceKey(account);
      referenceKeys[provider][account.id] = key;
      const previous = cache.providers[provider]?.accounts.find(a => a.id === account.id);
      const sameReference = rawCache.referenceKeys?.[provider]?.[account.id] === key;
      if (account.enabled === false) {
        return { ...metadata, status: 'unknown', code: 'disabled', message: usageFailureMessage('disabled'),
          source: 'unavailable', fetchedAt: null, checkedAt: now, stale: true, windows: [] };
      }
      const checkedAt = previous?.checkedAt;
      if (!refresh && sameReference && previous?.enabled !== false && checkedAt !== null
        && Number.isFinite(checkedAt) && checkedAt <= now && now - checkedAt < USAGE_CACHE_TTL_MS
        && !(previous.stale && ['ok', 'quota_exhausted'].includes(previous.status))
        && !(allowProbe && provider === 'claude' && previous.code === 'permission_denied')) {
        return { ...previous, ...metadata };
      }
      fetched = true;
      let usage;
      try {
        const credential = account.credential.type === 'managed'
          ? await (await import('./refresh.js')).routingCredential(provider, account, { fetchFn, now, timeoutMs })
          : readCredential(account);
        usage = await fetchAccountUsage(provider, credential, { fetchFn, now, timeoutMs, allowProbe, endpoints });
      } catch (err) {
        const code = err instanceof CredentialError ? err.code
          : ['expired_login', 'network_error'].includes(err?.code) ? err.code : 'invalid_credential';
        usage = { status: code === 'network_error' ? 'network_error' : 'expired_login', code, message: usageFailureMessage(code),
          source: 'unavailable', fetchedAt: now, windows: [] };
      }
      // Setup tokens may read quota headers on real work but lack permission
      // for OAuth usage. Preserve a still-fresh observation, not its age.
      if (provider === 'claude' && usage.code === 'permission_denied' && sameReference
        && previous && !previous.stale && ['claude-headers', 'claude-probe'].includes(previous.source)) {
        return { ...previous, ...metadata, checkedAt: now };
      }
      if (sameReference && ['ok', 'quota_exhausted'].includes(usage.status)) {
        usage = mergeHeaderObservation(usage, previous, now);
      }
      const good = usage.status === 'ok' || usage.status === 'quota_exhausted';
      const keepPrevious = !good && !usage.windows.length && sameReference && previous?.windows.length;
      return { ...metadata, ...usage,
        fetchedAt: keepPrevious ? previous.fetchedAt : usage.fetchedAt,
        checkedAt: now, stale: !good || usage.stale === true,
        windows: keepPrevious ? previous.windows : usage.windows };
    })) };
  }));
  // Preserve upstream no-accounts behavior: do not create a cache or state dir.
  if (!Object.keys(snapshot.providers).length) return empty();
  if (fetched || JSON.stringify(snapshot.providers) !== JSON.stringify(cache.providers)) {
    await withStoreLock(cachePath(stateDir), async () => {
      const latest = readRawCache(stateDir);
      // A slower refresh must not replace a newer observation from another
      // process. Merge only observations for still-configured references.
      for (const provider of Object.keys(snapshot.providers)) {
        snapshot.providers[provider].accounts = snapshot.providers[provider].accounts.map(account => {
          const newer = latest.providers[provider]?.accounts?.find(a => a.id === account.id);
          if (latest.referenceKeys?.[provider]?.[account.id] === referenceKeys[provider][account.id]
            && Number.isFinite(newer?.checkedAt) && newer.checkedAt > (account.checkedAt ?? 0)) {
            // Preserve its stored freshness even if this fetch started before
            // the observation. The public read still rejects future times.
            return sanitizeAccount(newer, Math.max(now, newer.checkedAt), USAGE_CACHE_TTL_MS) ?? account;
          }
          return account;
        });
      }
      atomicPrivateJson(cachePath(stateDir), { ...snapshot, referenceKeys });
    });
  }
  return sanitizeSnapshot(snapshot, now, USAGE_CACHE_TTL_MS);
}

export async function fetchUsageSnapshot({
  stateDir = STATE_DIR, refresh = false, fetchFn = globalThis.fetch,
  now = Date.now(), timeoutMs, allowProbe = false, endpoints,
} = {}) {
  const key = resolve(stateDir);
  // Dashboard refreshes can overlap; share the same request within a process.
  const active = activeFetches.get(key);
  if (active) {
    const snapshot = await active.pending;
    if (!(allowProbe && !active.allowProbe) && !(refresh && !active.refresh)) return snapshot;
    // An explicit probe or forced refresh must not disappear behind a
    // background read that started without that authorization.
    return fetchUsageSnapshot({ stateDir, refresh, fetchFn, now, timeoutMs, allowProbe, endpoints });
  }
  const pending = collectSnapshot({ stateDir, refresh, fetchFn, now, timeoutMs, allowProbe, endpoints });
  activeFetches.set(key, { pending, allowProbe, refresh });
  try { return await pending; } finally { activeFetches.delete(key); }
}

// Capture quota headers on real routed work so the usage display need not
// generate requests to obtain the same observation. Missing headers are a no-op.
export async function recordUsageHeaders(provider, accountId, headers, {
  stateDir = STATE_DIR, now = Date.now(),
} = {}) {
  const usage = usageFromHeaders(provider, headers, { now });
  if (!['ok', 'quota_exhausted'].includes(usage.status)) return null;
  const config = readAccounts(stateDir);
  const account = config.providers[provider]?.accounts.find(a => a.id === accountId);
  if (!account) return null;
  return withStoreLock(cachePath(stateDir), async () => {
    const raw = readRawCache(stateDir);
    const snapshot = sanitizeSnapshot(raw, now, USAGE_CACHE_TTL_MS);
    const section = snapshot.providers[provider] ||= { accounts: [] };
    const index = section.accounts.findIndex(a => a.id === accountId);
    if (index >= 0 && section.accounts[index].checkedAt > now) return section.accounts[index];
    const observation = raw.referenceKeys?.[provider]?.[account.id] === referenceKey(account)
      ? mergeHeaderObservation(usage, section.accounts[index], now) : usage;
    const entry = { id: account.id, name: account.name, enabled: account.enabled,
      ...observation, checkedAt: now, stale: observation.stale === true };
    if (index >= 0) section.accounts[index] = entry;
    else section.accounts.push(entry);
    const referenceKeys = {};
    for (const key of PROVIDERS) {
      referenceKeys[key] = {};
      for (const a of config.providers[key]?.accounts || []) {
        if (raw.referenceKeys?.[key]?.[a.id] === referenceKey(a)) referenceKeys[key][a.id] = referenceKey(a);
      }
    }
    referenceKeys[provider][account.id] = referenceKey(account);
    atomicPrivateJson(cachePath(stateDir), { ...snapshot, fetchedAt: now, referenceKeys });
    return entry;
  });
}
