import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAccountProxy, routerToken, upstreamRoute, upstreamHeaders } from '../src/accounts/proxy.js';

const root = mkdtempSync(join(tmpdir(), 'unsnooze-router-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
async function fixture(options = {}) {
  const stateDir = join(root, String(n++));
  const server = await startAccountProxy({ stateDir, port: 0,
    selectFn: async () => ({ account: { id: 'a' } }),
    credentialFn: async () => ({ accessToken: 'fake-provider', accountId: 'fake-account' }),
    failureFn: async () => {}, usageHeadersFn: async () => {}, ...options });
  const token = routerToken(stateDir);
  return { ...server, token, stateDir, url: `http://127.0.0.1:${server.port}` };
}

test('router auth, private token, exact route allowlist and health identity', async () => {
  const s = await fixture({ health: () => ({ instanceId: 'instance', workerId: 'worker' }) });
  try {
    assert.equal((await fetch(s.url + '/health')).status, 401);
    const r = await fetch(s.url + '/health', { headers: { authorization: `Bearer ${s.token}` } });
    assert.equal((await r.json()).workerId, 'worker');
    assert.equal(routerToken(s.stateDir), s.token);
    assert.equal(readFileSync(join(s.stateDir, 'router-token'), 'utf8').length, 43);
    for (const p of ['https://evil.invalid/claude/v1/messages', '/claude/../foo', '/claude/%2fetc', '/codex/login', '/health?x=1']) {
      assert.equal(upstreamRoute(p), null);
    }
    assert.deepEqual(upstreamRoute('/codex/responses'), { provider: 'codex', path: '/codex/responses' });
    assert.deepEqual(upstreamRoute('/codex/models?client_version=1'), { provider: 'codex', path: '/models?client_version=1' });
  } finally { await s.close(); }
});

test('outbound credentials replaced and transport/cookie secrets never forwarded', () => {
  const h = upstreamHeaders({ authorization: 'local', cookie: 'secret', 'x-api-key': 'secret',
    'proxy-authorization': 'secret', connection: 'x-extra', 'x-extra': 'secret', session_id: 'session-42' },
  'codex', { accessToken: 'provider', accountId: 'account' });
  assert.equal(h.get('authorization'), 'Bearer provider');
  assert.equal(h.get('session_id'), 'session-42');
  for (const k of ['cookie', 'x-api-key', 'proxy-authorization', 'connection', 'x-extra']) assert.equal(h.get(k), null);
});

test('limit stop switches and retries the same full conversation without rewriting payload', async () => {
  const calls = [], failures = [], selected = [];
  const s = await fixture({ selectFn: async (_p, options) => {
    selected.push(options.exclude.slice());
    return { account: { id: options.exclude.includes('a') ? 'b' : 'a' } };
  }, credentialFn: async (_p, a) => ({ accessToken: a.id }),
  failureFn: async (...args) => failures.push(args),
  fetchFn: async (url, options) => {
    calls.push({ url, body: options.body.toString(), session: options.headers.get('session_id'), auth: options.headers.get('authorization') });
    return calls.length === 1 ? new Response('{"error":{"type":"usage_limit_reached"}}', { status: 429 })
      : new Response('data: {"type":"response.completed"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  try {
    const body = JSON.stringify({ input: [{ role: 'user', content: 'same conversation' }], stream: true });
    const r = await fetch(s.url + '/codex/responses', { method: 'POST',
      headers: { authorization: `Bearer ${s.token}`, session_id: 'saved-session' }, body });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /response.completed/);
    assert.deepEqual(calls.map(c => c.auth), ['Bearer a', 'Bearer b']);
    assert.ok(calls.every(c => c.body === body && c.session === 'saved-session'));
    assert.equal(failures[0][2], 'quota_exhausted');
    assert.deepEqual(selected, [[], ['a']]);
  } finally { await s.close(); }
});

test('expired login and network outage are distinct from quota; provider error bodies suppressed', async () => {
  for (const scenario of ['expired', 'network', 'forbidden']) {
    let attempts = 0;
    const s = await fixture({ selectFn: async () => ++attempts === 1 ? { account: { id: 'a' } } : { account: null, reason: 'expired_login' },
      fetchFn: async () => { if (scenario === 'network') throw new Error('FAKE_SECRET_FROM_EXCEPTION');
        return new Response('FAKE_SECRET_FROM_PROVIDER', { status: scenario === 'expired' ? 401 : 403 }); } });
    try {
      const r = await fetch(s.url + '/claude/v1/messages', { method: 'POST', headers: { authorization: `Bearer ${s.token}` }, body: '{}' });
      assert.equal(r.status, { expired: 401, network: 502, forbidden: 403 }[scenario]);
      const text = await r.text(); assert.doesNotMatch(text, /FAKE_SECRET|usage limit/);
    } finally { await s.close(); }
  }
});

test('all exhausted waits, a later verified request succeeds at reset', async () => {
  let ready = false;
  const s = await fixture({ selectFn: async () => ready ? { account: { id: 'a' } }
    : { account: null, reason: 'all_exhausted', retryAt: Date.now() + 1000 },
  fetchFn: async () => new Response('resumed') });
  try {
    const request = () => fetch(s.url + '/claude/v1/messages', { method: 'POST', headers: { authorization: `Bearer ${s.token}` }, body: '{}' });
    const stopped = await request(); assert.equal(stopped.status, 429); assert.ok(stopped.headers.get('retry-after'));
    ready = true;
    assert.equal(await (await request()).text(), 'resumed');
  } finally { await s.close(); }
});

test('incremental server response chain is not silently replayed on another account', async () => {
  let calls = 0;
  const s = await fixture({ selectFn: async (_p, o) => ({ account: { id: o.exclude.length ? 'b' : 'a' } }),
    fetchFn: async () => { calls++; return new Response('{"error":{"type":"usage_limit_reached"}}', { status: 429 }); } });
  try {
    const r = await fetch(s.url + '/codex/responses', { method: 'POST', headers: { authorization: `Bearer ${s.token}` },
      body: JSON.stringify({ previous_response_id: 'response-from-another-account', input: [] }) });
    assert.equal(r.status, 409); assert.equal(calls, 1);
  } finally { await s.close(); }
});

test('corrupt router token and nonloopback binding fail closed', async () => {
  const s = await fixture(); await s.close();
  writeFileSync(join(s.stateDir, 'router-token'), 'fake-secret-corruption', { mode: 0o600 });
  assert.throws(() => routerToken(s.stateDir), error => !error.message.includes('fake-secret'));
  await assert.rejects(startAccountProxy({ host: '0.0.0.0' }), /loopback/);
});
