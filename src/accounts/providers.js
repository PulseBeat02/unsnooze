const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export const USAGE_ENDPOINTS = Object.freeze({
  claudeUsage: 'https://api.anthropic.com/api/oauth/usage',
  claudeProbe: 'https://api.anthropic.com/v1/messages',
  codexUsage: 'https://chatgpt.com/backend-api/wham/usage',
  agyLoad: 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
  agyQuota: 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
});

const SOURCES = { claude: 'claude-oauth', codex: 'codex-usage', agy: 'agy-quota' };
const MESSAGES = {
  expired_login: 'Login has expired. Renew it with the credential owner.',
  permission_denied: 'The login does not permit this usage request.',
  network_error: 'Usage service could not be reached.',
  timeout: 'Usage request timed out.',
  rate_limited: 'Usage service is rate limited; quota is unverified.',
  unavailable: 'Usage service is unavailable.',
  malformed: 'Usage service returned unrecognized quota data.',
  stale_data: 'Usage service returned a window whose reset has passed.',
  invalid_credential: 'The login is missing or invalid.',
  credential_unavailable: 'Credential file is unavailable.',
  disabled: 'Account is disabled.',
  unsupported: 'Usage is unavailable for this provider.',
};

export function usageFailureMessage(code) {
  return MESSAGES[code] || MESSAGES.unavailable;
}

class ProviderError extends Error {
  constructor(code, status = 'unknown') {
    super(MESSAGES[code] || MESSAGES.unavailable);
    this.code = code;
    this.status = status;
  }
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const malformed = () => { throw new ProviderError('malformed'); };

function percent(value, fraction = false) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return malformed();
  const n = fraction ? (1 - value) * 100 : value;
  if (n < 0 || n > 100) return malformed();
  return Math.round(n * 1e6) / 1e6;
}

export function resetTime(value) {
  if (value == null) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return malformed();
  const n = typeof value === 'string' && !/^\d+(\.\d+)?$/.test(value)
    ? Date.parse(value) : Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 8.64e15) return malformed();
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

function labelForSeconds(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return malformed();
  if (value === 604800) return 'weekly';
  if (value % 86400 === 0) return `${value / 86400}d`;
  if (value % 3600 === 0) return `${value / 3600}h`;
  if (value % 60 === 0) return `${value / 60}m`;
  return `${value}s`;
}

function safeLabel(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim().slice(0, 80) || fallback;
}

export function parseClaudeUsage(body) {
  if (!record(body)) return malformed();
  const fields = [
    ['five_hour', '5h'], ['seven_day', 'weekly'],
    ['seven_day_opus', 'weekly', 'Opus'],
    ['seven_day_sonnet', 'weekly', 'Sonnet'],
    ['seven_day_oauth_apps', 'weekly', 'OAuth apps'],
    ['seven_day_cowork', 'weekly', 'Cowork'],
  ];
  const windows = [];
  for (const [id, label, group] of fields) {
    if (body[id] == null) continue;
    if (!record(body[id])) return malformed();
    windows.push({ id, label, ...(group ? { group } : {}),
      usedPercent: percent(body[id].utilization), resetAt: resetTime(body[id].resets_at) });
  }
  if (!windows.length) return malformed();
  return windows;
}

export function parseCodexUsage(body, { now = Date.now() } = {}) {
  if (!record(body)) return malformed();
  const windows = [];
  const add = (limits, prefix, group) => {
    if (!record(limits)) return malformed();
    for (const key of ['primary_window', 'secondary_window']) {
      const w = limits[key];
      if (w == null) continue;
      if (!record(w)) return malformed();
      const resetAt = w.reset_at != null ? resetTime(w.reset_at)
        : typeof w.reset_after_seconds === 'number' && Number.isFinite(w.reset_after_seconds)
          && w.reset_after_seconds >= 0 ? now + w.reset_after_seconds * 1000 : null;
      windows.push({ id: `${prefix}${key}`, label: labelForSeconds(w.limit_window_seconds),
        ...(group ? { group } : {}), usedPercent: percent(w.used_percent), resetAt });
    }
  };
  if (body.rate_limit != null) add(body.rate_limit, '');
  if (body.code_review_rate_limit != null) add(body.code_review_rate_limit, 'code_review:', 'Code review');
  if (body.additional_rate_limits != null) {
    if (!Array.isArray(body.additional_rate_limits)) return malformed();
    body.additional_rate_limits.forEach((limit, i) => {
      if (!record(limit)) return malformed();
      add(limit.rate_limit, `additional:${i}:`, safeLabel(limit.limit_name, 'Additional limit'));
    });
  }
  if (!windows.length) return malformed();
  return windows;
}

function numericHeader(headers, key) {
  const value = headers?.get?.(key);
  if (value == null || !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : malformed();
}

// The routing proxy and explicit probes can use exact response headers without
// interpreting status 429 as proof that any particular quota is exhausted.
export function parseCodexQuotaHeaders(headers, { now = Date.now() } = {}) {
  const windows = [];
  for (const id of ['primary', 'secondary']) {
    const prefix = `x-codex-${id}`;
    const used = numericHeader(headers, `${prefix}-used-percent`);
    if (used === null) continue;
    const minutes = numericHeader(headers, `${prefix}-window-minutes`);
    const reset = headers.get(`${prefix}-reset-at`);
    const after = numericHeader(headers, `${prefix}-reset-after-seconds`);
    windows.push({ id: `${id}_window`, label: labelForSeconds(minutes * 60),
      usedPercent: percent(used), resetAt: reset != null ? resetTime(reset)
        : after !== null && after >= 0 ? now + after * 1000 : null });
  }
  if (!windows.length) return malformed();
  return windows;
}

export function parseClaudeQuotaHeaders(headers) {
  const windows = [];
  for (const [id, label, group] of [['5h', '5h'], ['7d', 'weekly'],
    ['7d-opus', 'weekly', 'Opus'], ['7d-sonnet', 'weekly', 'Sonnet']]) {
    const prefix = `anthropic-ratelimit-unified-${id}`;
    const used = numericHeader(headers, `${prefix}-utilization`);
    if (used === null) continue;
    windows.push({ id, label, ...(group ? { group } : {}), usedPercent: percent(used * 100),
      resetAt: resetTime(headers.get(`${prefix}-reset`)) });
  }
  if (!windows.length) return malformed();
  return windows;
}

function agyGroup(value) {
  if (typeof value !== 'string') return malformed();
  if (/gemini/i.test(value)) return 'Gemini Models';
  if (/claude|gpt/i.test(value)) return 'Claude and GPT models';
  return malformed();
}

function agyWindow(value) {
  if (typeof value === 'number') return labelForSeconds(value);
  if (typeof value !== 'string') return malformed();
  if (/^(5h|five[_ -]?hour|five[_ -]?hours|18000s?)$/i.test(value)) return '5h';
  if (/^(weekly|7d|seven[_ -]?day|seven[_ -]?days|604800s?)$/i.test(value)) return 'weekly';
  return malformed();
}

export function parseAgyUsage(body) {
  if (!record(body)) return malformed();
  const summary = body.userQuotaSummary ?? body;
  if (!record(summary)) return malformed();
  const windows = [];
  const add = (w, group, label) => {
    if (!record(w)) return malformed();
    const usedPercent = percent(w.remainingFraction ?? w.remaining_fraction, true);
    const resetAt = resetTime(w.resetTime ?? w.reset_time);
    const id = `${group === 'Gemini Models' ? 'gemini' : 'claude-gpt'}:${label}`;
    const prior = windows.find(item => item.id === id);
    // Differing per-model values cannot be represented as one shared pool.
    if (prior) {
      if (prior.usedPercent !== usedPercent || prior.resetAt !== resetAt) return malformed();
    } else windows.push({ id, label, group, usedPercent, resetAt });
  };
  const buckets = summary.quotaBuckets ?? summary.buckets;
  if (buckets != null) {
    if (!Array.isArray(buckets)) return malformed();
    for (const b of buckets) {
      if (!record(b)) return malformed();
      add(b, agyGroup(b.groupName ?? b.quotaGroup ?? b.modelId ?? b.bucketId),
        agyWindow(b.window ?? b.windowType ?? b.windowDuration ?? b.limitWindowSeconds));
    }
  }
  const groups = summary.quotaGroups ?? summary.groups;
  if (groups != null) {
    const entries = Array.isArray(groups) ? groups.map(g => [g?.name ?? g?.groupName ?? g?.displayName, g])
      : record(groups) ? Object.entries(groups) : malformed();
    for (const [name, data] of entries) {
      if (!record(data)) return malformed();
      const group = agyGroup(name);
      const groupWindows = data.windows ?? data.buckets;
      if (groupWindows != null) {
        if (!Array.isArray(groupWindows)) return malformed();
        for (const w of groupWindows) add(w, group, agyWindow(w?.window ?? w?.windowType ?? w?.label));
      } else {
        for (const [key, label] of [['fiveHour', '5h'], ['five_hour', '5h'], ['weekly', 'weekly'],
          ['sevenDay', 'weekly'], ['seven_day', 'weekly']]) {
          if (data[key] != null) add(data[key], group, label);
        }
      }
    }
  }
  if (!windows.length) return malformed();
  return windows;
}

function httpError(status) {
  if (status === 401) return new ProviderError('expired_login', 'expired_login');
  if (status === 403) return new ProviderError('permission_denied');
  if (status === 429) return new ProviderError('rate_limited');
  return new ProviderError('unavailable');
}

async function request(url, init, { fetchFn, timeoutMs }, consume) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(async () => {
        const response = await fetchFn(url, { ...init, signal: controller.signal, redirect: 'error' });
        return consume(response);
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ProviderError('timeout', 'network_error'));
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError('network_error', 'network_error');
  } finally { clearTimeout(timer); }
}

async function jsonRequest(url, init, options) {
  return request(url, init, options, async response => {
    if (!response?.ok) throw httpError(response?.status);
    try {
      const raw = await response.text();
      if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) return malformed();
      return JSON.parse(raw);
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      return malformed();
    }
  });
}

function result(windows, source, now, limited = false) {
  if (windows.some(w => w.resetAt !== null && w.resetAt <= now)) {
    return { status: 'unknown', code: 'stale_data', message: MESSAGES.stale_data,
      source, fetchedAt: now, windows };
  }
  const exhausted = windows.some(w => w.usedPercent >= 100);
  if (limited && !exhausted) {
    return { status: 'unknown', code: 'rate_limited', message: MESSAGES.rate_limited,
      source, fetchedAt: now, windows };
  }
  return { status: exhausted ? 'quota_exhausted' : 'ok', source, fetchedAt: now, windows };
}

export function usageFromHeaders(provider, headers, { now = Date.now() } = {}) {
  const source = `${provider}-headers`;
  try {
    const windows = provider === 'claude' ? parseClaudeQuotaHeaders(headers)
      : provider === 'codex' ? parseCodexQuotaHeaders(headers, { now }) : malformed();
    return result(windows, source, now);
  } catch {
    return { status: 'unknown', code: 'malformed', message: MESSAGES.malformed,
      source, fetchedAt: now, windows: [] };
  }
}

export async function fetchAccountUsage(provider, credential, {
  fetchFn = globalThis.fetch, now = Date.now(), timeoutMs = DEFAULT_TIMEOUT_MS,
  endpoints = {}, allowProbe = false, probeModel = 'claude-haiku-4-5-20251001',
} = {}) {
  let source = SOURCES[provider] || 'unavailable';
  try {
    const accessToken = credential?.accessToken;
    if (typeof accessToken !== 'string' || !accessToken || /[\s\x00-\x1f\x7f]/.test(accessToken)) {
      throw new ProviderError('invalid_credential', 'expired_login');
    }
    if (credential.expiresAt != null && (!Number.isFinite(credential.expiresAt) || credential.expiresAt <= now)) {
      throw new ProviderError('expired_login', 'expired_login');
    }
    const urls = { ...USAGE_ENDPOINTS, ...endpoints };
    const options = { fetchFn, timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS };
    const headers = { authorization: `Bearer ${accessToken}`, accept: 'application/json' };
    if (provider === 'claude') {
      Object.assign(headers, { 'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01' });
      try {
        const body = await jsonRequest(urls.claudeUsage, { headers }, options);
        return result(parseClaudeUsage(body), source, now);
      } catch (err) {
        if (!allowProbe || !(err instanceof ProviderError)
          || !['permission_denied', 'unavailable', 'malformed'].includes(err.code)) throw err;
        source = 'claude-probe';
        return await request(urls.claudeProbe, {
          method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ model: probeModel, max_tokens: 1,
            system: "You are Claude Code, Anthropic's official CLI for Claude.",
            messages: [{ role: 'user', content: '.' }] }),
        }, options, async response => {
          // Ignore the generated message entirely; only exact quota headers matter.
          try {
            if (!response?.ok && response?.status !== 429) throw httpError(response?.status);
            return result(parseClaudeQuotaHeaders(response.headers), source, now, response.status === 429);
          } finally { try { await response?.body?.cancel?.(); } catch { /* no response body is needed */ } }
        });
      }
    }
    if (provider === 'codex') {
      if (typeof credential.accountId !== 'string' || !credential.accountId
        || /[\s\x00-\x1f\x7f]/.test(credential.accountId)) {
        throw new ProviderError('invalid_credential', 'expired_login');
      }
      headers['chatgpt-account-id'] = credential.accountId;
      headers['user-agent'] = 'unsnooze';
      const body = await jsonRequest(urls.codexUsage, { headers }, options);
      const limits = [body.rate_limit, body.code_review_rate_limit,
        ...(Array.isArray(body.additional_rate_limits) ? body.additional_rate_limits.map(item => item?.rate_limit) : [])];
      return result(parseCodexUsage(body, { now }), source, now,
        limits.some(limit => limit?.allowed === false || limit?.limit_reached === true));
    }
    if (provider === 'agy') {
      Object.assign(headers, { 'user-agent': 'antigravity', 'content-type': 'application/json' });
      const loaded = await jsonRequest(urls.agyLoad, { method: 'POST', headers,
        body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY', platform: 'LINUX_AMD64', pluginType: 'GEMINI' } }) }, options);
      const project = typeof loaded?.cloudaicompanionProject === 'string' ? loaded.cloudaicompanionProject
        : loaded?.cloudaicompanionProject?.id;
      if (typeof project !== 'string' || !project.trim()) return malformed();
      const body = await jsonRequest(urls.agyQuota, { method: 'POST', headers,
        body: JSON.stringify({ project }) }, options);
      return result(parseAgyUsage(body), source, now);
    }
    throw new ProviderError('unsupported');
  } catch (err) {
    const error = err instanceof ProviderError ? err : new ProviderError('malformed');
    return { status: error.status, code: error.code, message: error.message, source, fetchedAt: now, windows: [] };
  }
}
