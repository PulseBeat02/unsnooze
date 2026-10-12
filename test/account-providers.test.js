import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAccountUsage, parseClaudeUsage, parseCodexUsage, parseAgyUsage,
  parseCodexQuotaHeaders, parseClaudeQuotaHeaders, usageFromHeaders, USAGE_ENDPOINTS } from '../src/accounts/providers.js';

const NOW = Date.parse('2026-10-12T00:00:00Z');
const RESET = NOW + 3_600_000;
const credential = { accessToken: 'access-fixture-secret', accountId: 'workspace-fixture', expiresAt: RESET };
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const claude = { five_hour: { utilization: 42.75, resets_at: new Date(RESET).toISOString() },
  seven_day: { utilization: 13, resets_at: new Date(NOW + 604800000).toISOString() } };
const codex = { rate_limit: { primary_window: { used_percent: 12, reset_at: RESET / 1000,
  limit_window_seconds: 18000 }, secondary_window: { used_percent: 4, reset_at: (NOW + 604800000) / 1000,
  limit_window_seconds: 604800 } } };

test('Claude OAuth usage is exact, uses bearer/OAuth headers, and omits response metadata', async () => {
  let request;
  const usage = await fetchAccountUsage('claude', credential, { now: NOW, fetchFn: async (url, init) => {
    request = { url, init };
    return response({ ...claude, email: 'private', access_token: 'never-persist',
      seven_day_sonnet: { utilization: 7, resets_at: RESET } });
  } });
  assert.equal(request.url, USAGE_ENDPOINTS.claudeUsage);
  assert.equal(request.init.headers.authorization, `Bearer ${credential.accessToken}`);
  assert.equal(request.init.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(request.init.redirect, 'error');
  assert.equal(usage.status, 'ok');
  assert.equal(usage.windows[0].usedPercent, 42.75);
  assert.equal(usage.windows[0].resetAt, RESET);
  assert.equal(usage.windows[2].group, 'Sonnet');
  assert.doesNotMatch(JSON.stringify(usage), /private|never-persist|access-fixture/);
});

test('Codex usage preserves selected workspace and derives weekly primary labels from duration', async () => {
  let header;
  const usage = await fetchAccountUsage('codex', credential, { now: NOW, fetchFn: async (url, init) => {
    assert.equal(url, USAGE_ENDPOINTS.codexUsage);
    header = init.headers['chatgpt-account-id'];
    return response({ rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 604800,
      reset_at: RESET / 1000 }, secondary_window: null } });
  } });
  assert.equal(header, 'workspace-fixture');
  assert.equal(usage.windows[0].label, 'weekly');
  assert.equal(usage.windows[0].resetAt, RESET);
  const windows = parseCodexUsage({ ...codex, additional_rate_limits: [
    { limit_name: 'GPT Models', rate_limit: { primary_window: { used_percent: 8,
      limit_window_seconds: 3600, reset_after_seconds: 500 } } },
  ] }, { now: NOW });
  assert.equal(windows[2].label, '1h');
  assert.equal(windows[2].group, 'GPT Models');
  assert.equal(windows[2].resetAt, NOW + 500000);
});

test('quota exhausted requires exact 100% and does not come from generic HTTP throttling', async () => {
  const quota = await fetchAccountUsage('claude', credential, { now: NOW,
    fetchFn: async () => response({ five_hour: { utilization: 100, resets_at: RESET } }) });
  assert.equal(quota.status, 'quota_exhausted');
  const throttle = await fetchAccountUsage('claude', credential, { now: NOW,
    fetchFn: async () => response({ token: credential.accessToken }, 429) });
  assert.equal(throttle.status, 'unknown');
  assert.equal(throttle.code, 'rate_limited');
  assert.deepEqual(throttle.windows, []);
  const blocked = await fetchAccountUsage('codex', credential, { now: NOW,
    fetchFn: async () => response({ rate_limit: { ...codex.rate_limit, allowed: false, limit_reached: true } }) });
  assert.equal(blocked.status, 'unknown', 'a provider denying access cannot qualify from a lower percentage');
});

test('expired credentials avoid any HTTP, while 401, 403, and service errors remain distinct', async () => {
  for (const access of [{ ...credential, expiresAt: NOW }, { accessToken: '' }]) {
    const usage = await fetchAccountUsage('claude', access, { now: NOW,
      fetchFn: () => { throw new Error('must not fetch'); } });
    assert.equal(usage.status, 'expired_login');
  }
  for (const [status, wanted, code] of [[401, 'expired_login', 'expired_login'],
    [403, 'unknown', 'permission_denied'], [500, 'unknown', 'unavailable']]) {
    const usage = await fetchAccountUsage('claude', credential, { now: NOW,
      fetchFn: async () => response({ error: credential.accessToken }, status) });
    assert.equal(usage.status, wanted);
    assert.equal(usage.code, code);
    assert.doesNotMatch(JSON.stringify(usage), /access-fixture/);
  }
});

test('network failures, malformed bodies, and a hanging response body are bounded and sanitized', async () => {
  const broken = await fetchAccountUsage('claude', credential, { now: NOW,
    fetchFn: async () => { throw new Error(`bad ${credential.accessToken}`); } });
  assert.equal(broken.status, 'network_error');
  assert.doesNotMatch(JSON.stringify(broken), /access-fixture/);
  const invalid = await fetchAccountUsage('claude', credential, { now: NOW,
    fetchFn: async () => new Response('not-json-with-secret') });
  assert.equal(invalid.code, 'malformed');
  let signal;
  const hanging = await fetchAccountUsage('claude', credential, { now: NOW, timeoutMs: 10,
    fetchFn: async (url, init) => { signal = init.signal; return { ok: true, text: () => new Promise(() => {}) }; } });
  assert.equal(hanging.code, 'timeout');
  assert.equal(hanging.status, 'network_error');
  assert.equal(signal.aborted, true);
});

test('partial malformed, out-of-range, nonnumeric and past-reset quotas never appear healthy', async () => {
  for (const body of [null, [], {}, { five_hour: { utilization: '10' } },
    { five_hour: { utilization: -1 } }, { five_hour: { utilization: 101 } },
    { five_hour: { utilization: 1, resets_at: 'invalid' } },
    { ...claude, seven_day_opus: { utilization: null } }]) {
    const usage = await fetchAccountUsage('claude', credential, { now: NOW, fetchFn: async () => response(body) });
    assert.equal(usage.status, 'unknown');
    assert.equal(usage.code, 'malformed');
    assert.deepEqual(usage.windows, []);
  }
  const stale = await fetchAccountUsage('claude', credential, { now: NOW,
    fetchFn: async () => response({ five_hour: { utilization: 0, resets_at: NOW - 1 } }) });
  assert.equal(stale.code, 'stale_data');
  assert.equal(stale.status, 'unknown');
});

test('Claude probe is strictly opt-in, costs one output token, and reads only quota headers', async () => {
  let calls = 0;
  const fetchFn = async (url, init) => {
    calls++;
    if (url === USAGE_ENDPOINTS.claudeUsage) return response({}, 403);
    assert.equal(url, USAGE_ENDPOINTS.claudeProbe);
    assert.equal(JSON.parse(init.body).max_tokens, 1);
    return response({ message: 'ignored-secret' }, 200, {
      'anthropic-ratelimit-unified-5h-utilization': '0.425',
      'anthropic-ratelimit-unified-5h-reset': String(RESET / 1000),
      'anthropic-ratelimit-unified-7d-utilization': '0.2',
      'anthropic-ratelimit-unified-7d-reset': String((NOW + 604800000) / 1000),
    });
  };
  const defaultResult = await fetchAccountUsage('claude', credential, { fetchFn, now: NOW });
  assert.equal(defaultResult.code, 'permission_denied');
  assert.equal(calls, 1);
  const optedIn = await fetchAccountUsage('claude', credential, { fetchFn, now: NOW, allowProbe: true });
  assert.equal(calls, 3);
  assert.equal(optedIn.status, 'ok');
  assert.equal(optedIn.source, 'claude-probe');
  assert.equal(optedIn.windows[0].usedPercent, 42.5);
  assert.doesNotMatch(JSON.stringify(optedIn), /ignored-secret/);
});

test('ordinary Claude and Codex response quota headers parse actual USED numbers', () => {
  const h = new Headers({ 'x-codex-primary-used-percent': '92.5', 'x-codex-primary-window-minutes': '300',
    'x-codex-primary-reset-after-seconds': '90' });
  assert.deepEqual(parseCodexQuotaHeaders(h, { now: NOW }), [
    { id: 'primary_window', label: '5h', usedPercent: 92.5, resetAt: NOW + 90000 },
  ]);
  assert.equal(usageFromHeaders('codex', h, { now: NOW }).source, 'codex-headers');
  assert.equal(usageFromHeaders('claude', new Headers(), { now: NOW }).status, 'unknown');
  assert.throws(() => parseClaudeQuotaHeaders(new Headers({ 'anthropic-ratelimit-unified-5h-utilization': 'nan' })));
});

test('Antigravity posts metadata then project and separates Gemini and Claude/GPT quota windows', async () => {
  const calls = [];
  const usage = await fetchAccountUsage('agy', credential, { now: NOW, fetchFn: async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return url === USAGE_ENDPOINTS.agyLoad ? response({ cloudaicompanionProject: 'fixture-project' })
      : response({ quotaGroups: [
        { name: 'Gemini Models', fiveHour: { remainingFraction: 0.7, resetTime: RESET },
          weekly: { remainingFraction: 0.95, resetTime: NOW + 604800000 } },
        { name: 'Claude and GPT models', fiveHour: { remainingFraction: 0, resetTime: RESET },
          weekly: { remainingFraction: 0.5, resetTime: NOW + 604800000 } },
      ] });
  } });
  assert.deepEqual(calls[0].body, { metadata: { ideType: 'ANTIGRAVITY', platform: 'LINUX_AMD64', pluginType: 'GEMINI' } });
  assert.deepEqual(calls[1].body, { project: 'fixture-project' });
  assert.equal(calls[1].headers['user-agent'], 'antigravity');
  assert.equal(usage.status, 'quota_exhausted');
  assert.deepEqual(usage.windows.map(w => w.usedPercent), [30, 5, 100, 50]);
  assert.equal(usage.windows[0].group, 'Gemini Models');
  assert.equal(usage.windows[2].group, 'Claude and GPT models');
  assert.doesNotMatch(JSON.stringify(calls), /refresh_token|client_secret/);
});

test('Antigravity explicit bucket windows deduplicate shared models and reject ambiguous pools', () => {
  const b = { modelId: 'gemini-pro', remainingFraction: 0.75, resetTime: RESET, window: '5h' };
  assert.equal(parseAgyUsage({ buckets: [b, { ...b, modelId: 'gemini-flash' }] }).length, 1);
  assert.throws(() => parseAgyUsage({ buckets: [b, { ...b, remainingFraction: 0.5 }] }));
  assert.throws(() => parseAgyUsage({ buckets: [{ ...b, window: undefined }] }));
  assert.throws(() => parseAgyUsage({ buckets: [{ ...b, remainingFraction: 1.1 }] }));
  assert.throws(() => parseAgyUsage({ quotaGroups: [{ name: 'Unrecognized', weekly: b }] }));
  assert.throws(() => parseClaudeUsage({}));
  assert.throws(() => parseCodexUsage({ rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 0 } } }));
});

test('Antigravity stops after failed project discovery and handles malformed project responses', async () => {
  for (const [status, body, expected] of [[401, {}, 'expired_login'], [200, {}, 'unknown'],
    [200, { cloudaicompanionProject: {} }, 'unknown']]) {
    let calls = 0;
    const usage = await fetchAccountUsage('agy', credential, { now: NOW, fetchFn: async () => {
      calls++; return response(body, status);
    } });
    assert.equal(usage.status, expected);
    assert.equal(calls, 1);
  }
});
