import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-account-usage-'));
process.env.UNSNOOZE_STATE_DIR = DIR;
process.env.UNSNOOZE_CLAUDE_DIR = join(DIR, 'claude-empty');
process.env.UNSNOOZE_CODEX_DIR = join(DIR, 'codex-empty');
after(() => rmSync(DIR, { recursive: true, force: true }));
const { saveAccounts, emptyAccounts } = await import('../src/accounts/config.js');
const { atomicPrivateJson } = await import('../src/accounts/store.js');
const { fetchUsageSnapshot, readUsageCache, recordUsageHeaders, USAGE_CACHE_TTL_MS } = await import('../src/accounts/usage.js');
const { usageReportToJson, formatUsageText, buildAccountUsageReport, usageExitCode } = await import('../src/usage.js');

const NOW = Date.parse('2026-10-12T00:00:00Z');
const RESET = NOW + 3_600_000;
const response = (used = 20) => new Response(JSON.stringify({ five_hour: {
  utilization: used, resets_at: new Date(RESET).toISOString(),
} }));
let serial = 0;
function setup(entries = [{ provider: 'claude', id: 'alpha', name: 'Alpha', token: 'fixture-alpha-secret' }]) {
  const stateDir = mkdtempSync(join(DIR, 'state-'));
  const config = emptyAccounts();
  for (const entry of entries) {
    const path = join(stateDir, `credential-${serial++}`);
    const provider = entry.provider || 'claude';
    if (!entry.missing) writeFileSync(path, entry.body ? JSON.stringify(entry.body) : entry.token || 'fixture-token', { mode: 0o600 });
    config.providers[provider].accounts.push({ id: entry.id, name: entry.name || entry.id,
      enabled: entry.enabled !== false, priority: 0,
      credential: { type: entry.type || 'claude-token', path, ...(entry.recordId ? { recordId: entry.recordId } : {}) } });
  }
  saveAccounts(config, stateDir);
  return { stateDir, config };
}
const get = (snapshot, provider = 'claude', id = 'alpha') => snapshot.providers[provider].accounts.find(a => a.id === id);

test('account usage persists private exact snapshots, caches for one minute, and has no credential data', async () => {
  const { stateDir, config } = setup();
  let calls = 0;
  const fetchFn = async () => { calls++; return response(42.75); };
  const snapshot = await fetchUsageSnapshot({ stateDir, fetchFn, now: NOW });
  assert.equal(get(snapshot).windows[0].usedPercent, 42.75);
  assert.equal(get(snapshot).stale, false);
  assert.equal(get(snapshot).status, 'ok');
  assert.equal(snapshot.fetchedAt, NOW);
  assert.equal(calls, 1);
  const cache = join(stateDir, 'account-usage.json');
  assert.equal(statSync(cache).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(cache, 'utf8'), /fixture-alpha-secret|credential-|refreshToken|accessToken/);
  assert.doesNotMatch(JSON.stringify(snapshot), /referenceKeys|credential|accessToken/);
  assert.equal(readFileSync(config.providers.claude.accounts[0].credential.path, 'utf8'), 'fixture-alpha-secret');
  await fetchUsageSnapshot({ stateDir, fetchFn, now: NOW + 30_000 });
  assert.equal(calls, 1);
  await fetchUsageSnapshot({ stateDir, fetchFn, now: NOW + 30_001, refresh: true });
  assert.equal(calls, 2);
  assert.equal(get(readUsageCache({ stateDir, now: NOW + 30_001 + USAGE_CACHE_TTL_MS })).stale, true);
});

test('mixed accounts isolate login, network, quota, disabled, and malformed failures without aborting peers', async () => {
  const { stateDir } = setup([
    { id: 'live', token: 'live' }, { id: 'quota', token: 'quota' }, { id: 'network', token: 'network' },
    { id: 'missing', missing: true }, { id: 'disabled', enabled: false, missing: true },
    { id: 'bad', token: 'bad' }, { id: 'expired', type: 'managed', body: { accessToken: 'expired', expiresAt: NOW - 1 } },
  ]);
  let calls = 0;
  const snapshot = await fetchUsageSnapshot({ stateDir, now: NOW, fetchFn: async (url, init) => {
    calls++;
    const name = init.headers.authorization.slice(7);
    if (name === 'network') throw new Error('secret-network-detail');
    if (name === 'bad') return new Response('secret-malformed-body');
    assert.ok(['live', 'quota'].includes(name));
    return response(name === 'quota' ? 100 : 25);
  } });
  assert.equal(calls, 4);
  assert.deepEqual(snapshot.providers.claude.accounts.map(a => [a.id, a.status]), [
    ['live', 'ok'], ['quota', 'quota_exhausted'], ['network', 'network_error'],
    ['missing', 'expired_login'], ['disabled', 'unknown'], ['bad', 'unknown'], ['expired', 'expired_login'],
  ]);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret-network|secret-malformed|credential-/);
  assert.equal(get(snapshot, 'claude', 'disabled').code, 'disabled');
});

test('failed refresh retains last exact readings as stale and does not misrepresent its observation time', async () => {
  const { stateDir } = setup();
  await fetchUsageSnapshot({ stateDir, now: NOW, fetchFn: async () => response(47) });
  const failed = await fetchUsageSnapshot({ stateDir, now: NOW + 10_000, refresh: true,
    fetchFn: async () => { throw new Error('secret-token'); } });
  const account = get(failed);
  assert.equal(account.status, 'network_error');
  assert.equal(account.stale, true);
  assert.equal(account.fetchedAt, NOW);
  assert.equal(account.checkedAt, NOW + 10_000);
  assert.equal(account.windows[0].usedPercent, 47);
  assert.equal(get(readUsageCache({ stateDir, now: NOW + 11_000 })).stale, true);
});

test('changed credential reference invalidates cache, including last readings after a failed new login', async () => {
  const { stateDir, config } = setup();
  await fetchUsageSnapshot({ stateDir, now: NOW, fetchFn: async () => response(1) });
  config.providers.claude.accounts[0].credential.path = join(stateDir, 'missing-new-reference');
  saveAccounts(config, stateDir);
  const changed = await fetchUsageSnapshot({ stateDir, now: NOW + 1,
    fetchFn: async () => { throw new Error('should not fetch'); } });
  assert.equal(get(changed).status, 'expired_login');
  assert.deepEqual(get(changed).windows, []);
});

test('no configured accounts creates neither cache nor state directory and performs no HTTP', async () => {
  const stateDir = join(DIR, 'never-created');
  const snapshot = await fetchUsageSnapshot({ stateDir, now: NOW,
    fetchFn: () => { throw new Error('must not fetch'); } });
  assert.deepEqual(snapshot.providers, {});
  assert.equal(existsSync(stateDir), false);
});

test('cache reads sanitize fields, recalculate freshness, and tolerate malformed private cache', () => {
  const { stateDir } = setup();
  const path = join(stateDir, 'account-usage.json');
  atomicPrivateJson(path, { version: 1, fetchedAt: NOW, accessToken: 'never-visible', providers: { claude: { accounts: [
    { id: 'alpha', name: 'Alpha', status: 'ok', fetchedAt: NOW + 1, source: 'claude-oauth',
      windows: [{ id: '5h', label: '5h', usedPercent: 10, resetAt: RESET, accessToken: 'never-visible' }],
      credential: { path: 'never-visible' }, message: 'never-visible' },
  ] } } });
  const cache = readUsageCache({ stateDir, now: NOW });
  assert.equal(get(cache).stale, true, 'future observations are unverified');
  assert.doesNotMatch(JSON.stringify(cache), /never-visible|accessToken|credential/);
  writeFileSync(path, '{bad-cache', { mode: 0o600 });
  assert.deepEqual(readUsageCache({ stateDir }).providers, {});
});

test('concurrent dashboard fetches share one request and renew after window reset even before cache TTL', async () => {
  const { stateDir } = setup();
  let calls = 0;
  const fetchFn = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return response(); };
  const [a, b] = await Promise.all([
    fetchUsageSnapshot({ stateDir, now: NOW, fetchFn }), fetchUsageSnapshot({ stateDir, now: NOW, fetchFn }),
  ]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
  await fetchUsageSnapshot({ stateDir, now: RESET - 10, fetchFn, refresh: true });
  const refreshed = await fetchUsageSnapshot({ stateDir, now: RESET + 1, fetchFn });
  assert.equal(calls, 3);
  assert.equal(get(refreshed).code, 'stale_data');
});

test('routing headers update quota cache without HTTP and fresh Claude headers survive missing OAuth scope', async () => {
  const { stateDir } = setup();
  const headers = new Headers({ 'anthropic-ratelimit-unified-5h-utilization': '0.46',
    'anthropic-ratelimit-unified-5h-reset': String(RESET / 1000),
    'anthropic-ratelimit-unified-7d-utilization': '0.64',
    'anthropic-ratelimit-unified-7d-reset': String((NOW + 604800000) / 1000) });
  const written = await recordUsageHeaders('claude', 'alpha', headers, { stateDir, now: NOW });
  assert.equal(written.source, 'claude-headers');
  assert.equal(written.windows[0].usedPercent, 46);
  const snapshot = await fetchUsageSnapshot({ stateDir, now: NOW + 10_000, refresh: true,
    fetchFn: async () => new Response('{}', { status: 403 }) });
  assert.equal(get(snapshot).status, 'ok');
  assert.equal(get(snapshot).stale, false);
  assert.equal(get(snapshot).fetchedAt, NOW);
  assert.equal(get(snapshot).source, 'claude-headers');
  const aged = await fetchUsageSnapshot({ stateDir, now: NOW + 60_001,
    fetchFn: async () => new Response('{}', { status: 403 }) });
  assert.equal(get(aged).stale, true);
  assert.equal(get(aged).code, 'permission_denied');
  const before = readFileSync(join(stateDir, 'account-usage.json'), 'utf8');
  assert.equal(await recordUsageHeaders('claude', 'alpha', new Headers(), { stateDir }), null);
  assert.equal(readFileSync(join(stateDir, 'account-usage.json'), 'utf8'), before);
});

test('an explicit probe can repair recently cached permission errors without enabling background probes', async () => {
  const { stateDir } = setup();
  await fetchUsageSnapshot({ stateDir, now: NOW, fetchFn: async () => new Response('{}', { status: 403 }) });
  let calls = 0;
  const snapshot = await fetchUsageSnapshot({ stateDir, now: NOW + 1, allowProbe: true, fetchFn: async url => {
    calls++;
    if (url.endsWith('/usage')) return new Response('{}', { status: 403 });
    return new Response('{}', { headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.1',
      'anthropic-ratelimit-unified-5h-reset': String(RESET / 1000) } });
  } });
  assert.equal(calls, 2);
  assert.equal(get(snapshot).source, 'claude-probe');
  assert.equal(get(snapshot).status, 'ok');
});

test('an explicit probe waits for a concurrent background GET then uses its own authorization', async () => {
  const { stateDir } = setup();
  let release;
  const background = fetchUsageSnapshot({ stateDir, now: NOW,
    fetchFn: () => new Promise(resolve => { release = () => resolve(new Response('{}', { status: 403 })); }) });
  // The fake fetch starts on a microtask after credential loading.
  await new Promise(resolve => setImmediate(resolve));
  let calls = 0;
  const probe = fetchUsageSnapshot({ stateDir, now: NOW + 1, allowProbe: true, fetchFn: async url => {
    calls++;
    return url.endsWith('/usage') ? new Response('{}', { status: 403 })
      : new Response('{}', { headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.2',
        'anthropic-ratelimit-unified-5h-reset': String(RESET / 1000) } });
  } });
  release();
  await background;
  assert.equal(get(await probe).status, 'ok');
  assert.equal(calls, 2);
});

test('a slower refresh does not replace newer routing headers or persist a false stale marker', async () => {
  const { stateDir } = setup();
  let release;
  const background = fetchUsageSnapshot({ stateDir, now: NOW,
    fetchFn: () => new Promise(resolve => { release = () => resolve(response(12)); }) });
  await new Promise(resolve => setImmediate(resolve));
  await recordUsageHeaders('claude', 'alpha', new Headers({
    'anthropic-ratelimit-unified-5h-utilization': '0.4',
    'anthropic-ratelimit-unified-5h-reset': String(RESET / 1000),
  }), { stateDir, now: NOW + 1000 });
  release();
  await background;
  const cache = get(readUsageCache({ stateDir, now: NOW + 1001 }));
  assert.equal(cache.windows[0].usedPercent, 40);
  assert.equal(cache.fetchedAt, NOW + 1000);
  assert.equal(cache.stale, false);
});

test('partial response headers cannot erase another exhausted window or refresh its timestamp', async () => {
  const { stateDir } = setup();
  await fetchUsageSnapshot({ stateDir, now: NOW, fetchFn: async () => new Response(JSON.stringify({
    five_hour: { utilization: 20, resets_at: RESET }, seven_day: { utilization: 100, resets_at: RESET + 1000 },
  })) });
  const partial = new Headers({ 'anthropic-ratelimit-unified-5h-utilization': '0.3',
    'anthropic-ratelimit-unified-5h-reset': String(RESET / 1000) });
  const written = await recordUsageHeaders('claude', 'alpha', partial, { stateDir, now: NOW + 10_000 });
  assert.equal(written.windows.length, 2);
  assert.equal(written.status, 'quota_exhausted');
  assert.equal(written.fetchedAt, NOW);
  assert.equal(written.windows.find(w => w.label === 'weekly').usedPercent, 100);
  const aged = await recordUsageHeaders('claude', 'alpha', partial, { stateDir, now: NOW + 61_000 });
  assert.equal(aged.stale, true);
  assert.equal(aged.fetchedAt, NOW);
  assert.equal(aged.windows.find(w => w.label === 'weekly').fetchedAt, NOW);
  // A complete usage response is authoritative when the plan drops a window.
  const changedPlan = await fetchUsageSnapshot({ stateDir, now: NOW + 62_000, refresh: true,
    fetchFn: async () => response(31) });
  assert.equal(get(changedPlan).windows.length, 1);
  assert.equal(get(changedPlan).status, 'ok');
});

test('a partial explicit Claude probe cannot clear an existing exhausted weekly quota', async () => {
  const { stateDir } = setup();
  await fetchUsageSnapshot({ stateDir, now: NOW, fetchFn: async () => new Response(JSON.stringify({
    five_hour: { utilization: 20, resets_at: RESET }, seven_day: { utilization: 100, resets_at: RESET + 1000 },
  })) });
  const result = await fetchUsageSnapshot({ stateDir, now: NOW + 1000, refresh: true, allowProbe: true,
    fetchFn: async url => url.endsWith('/usage') ? new Response('{}', { status: 403 })
      : new Response('{}', { headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.3',
        'anthropic-ratelimit-unified-5h-reset': String(RESET / 1000) } }) });
  assert.equal(get(result).status, 'quota_exhausted');
  assert.equal(get(result).windows.length, 2);
  assert.equal(get(result).fetchedAt, NOW);
});

test('managed account text, JSON, exit codes, and Ink tab display exact USED, reset, and staleness', async () => {
  const { stateDir } = setup();
  const snapshot = await fetchUsageSnapshot({ stateDir, now: NOW, fetchFn: async () => response(42.75) });
  const report = buildAccountUsageReport(snapshot, { now: NOW + 2000 });
  const json = usageReportToJson(report);
  assert.equal(json.version, 1);
  assert.equal(json.providers.claude.accounts[0].windows[0].usedPercent, 42.75);
  assert.match(formatUsageText(report), /42\.75% USED/);
  assert.match(formatUsageText(report), /2026-10-12T01:00:00\.000Z/);
  assert.match(formatUsageText(report), /2s ago/);
  assert.equal(usageExitCode(report), 0);
  get(snapshot).windows[0].usedPercent = 96;
  assert.equal(usageExitCode(report), 2);
  get(snapshot).stale = true;
  get(snapshot).status = 'network_error';
  assert.equal(usageExitCode(report), 1);
  const { renderToString } = await import('ink');
  const React = (await import('react')).default;
  const { UsageTab } = await import('../src/dashboard/tabs/UsageTab.js');
  const output = renderToString(React.createElement(UsageTab, { data: report }));
  assert.match(output, /96% USED/);
  assert.match(output, /STALE/);
  assert.match(output, /network_error/);
  assert.match(output, /2026-10-12T01:00:00\.000Z/);
});

test('usage --json and dashboard integrate managed config through fake fetch without transcript scans', async () => {
  const { stateDir } = setup();
  const preloader = join(stateDir, 'fake-fetch.mjs');
  writeFileSync(preloader, `const nativeFetch=globalThis.fetch;
globalThis.fetch=async(url,...args)=>{
  if(String(url).startsWith('data:')) return nativeFetch(url,...args);
  if(url!=='https://api.anthropic.com/api/oauth/usage') throw new Error('Unexpected fixture request');
  return new Response(JSON.stringify({five_hour:{utilization:37.5,resets_at:new Date(Date.now()+3600000).toISOString()}}));
};`);
  const out = execFileSync(process.execPath, ['--import', preloader, 'bin/unsnooze.js', 'usage', '--json'], {
    env: { ...process.env, UNSNOOZE_STATE_DIR: stateDir, NO_COLOR: '1' }, encoding: 'utf8',
  });
  const json = JSON.parse(out);
  assert.equal(json.providers.claude.accounts[0].windows[0].usedPercent, 37.5);
  assert.deepEqual(json.agents, []);
  assert.equal(existsSync(join(stateDir, 'usage.json')), false);
  const { loadUsageSnapshot } = await import('../src/dashboard/data.js');
  const dashboard = await loadUsageSnapshot({ stateDir, fetchFn: async () => { throw new Error('cache only'); } });
  assert.equal(dashboard.providers.claude.accounts[0].windows[0].usedPercent, 37.5);
});
