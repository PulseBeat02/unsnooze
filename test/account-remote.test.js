import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startAccountProxy, routerToken } from '../src/accounts/proxy.js';
import { readResumeRequest } from '../src/accounts/sessions.js';
import { saveAccounts, emptyAccounts, readAccounts } from '../src/accounts/config.js';
import { readCredential } from '../src/accounts/credentials.js';
import { selectRoutingAccount } from '../src/accounts/routing.js';
import { fetchUsageSnapshot } from '../src/accounts/usage.js';
import { atomicPrivateJson } from '../src/accounts/store.js';
import {
  readRemoteConfig, validateRemoteConfig, enableRemote, disableRemote, remoteJson, syncRemoteAccounts,
} from '../src/accounts/remote.js';
import { hostListeners, systemdListeners, runHostRouter } from '../src/accounts/host.js';
import { cmdAccounts } from '../src/accounts/cli.js';

const root = mkdtempSync(join(tmpdir(), 'unsnooze-remote-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const dir = () => join(root, String(n++));

function hostConfig(stateDir) {
  const config = emptyAccounts();
  const secret = join(root, `claude-${n++}.token`);
  writeFileSync(secret, 'FAKE_PROVIDER_TOKEN', { mode: 0o600 });
  config.providers.claude.accounts.push({ id: 'claude-a', name: 'Main', priority: 0, enabled: true,
    credential: { type: 'claude-token', path: secret } });
  config.providers.claude.activeAccountId = 'claude-a';
  config.providers.codex.accounts.push({ id: 'codex-a', name: 'Codex', priority: 2, enabled: true,
    credential: { type: 'managed', path: join(root, 'codex-secret.json') } });
  saveAccounts(config, stateDir);
  return { config, secret };
}

async function host(options = {}) {
  const stateDir = dir();
  const socket = join(stateDir + '-sock');
  const calls = [];
  const proxy = await startAccountProxy({ stateDir, api: true,
    listeners: [{ path: socket, trusted: true }, { host: '127.0.0.1', port: 0 }],
    health: () => ({ service: 'unsnooze-accounts-host', version: 'test' }),
    selectFn: async () => ({ account: { id: 'claude-a', name: 'Main', enabled: true, priority: 0,
      credential: { type: 'claude-token', path: '/never/leaves' } } }),
    credentialFn: async () => ({ accessToken: 'FAKE_PROVIDER_TOKEN' }),
    failureFn: async () => {}, usageHeadersFn: async () => {},
    usageSnapshotFn: async options => ({ version: 1, fetchedAt: Date.now(), options, providers: {
      claude: { accounts: [{ id: 'claude-a', name: 'Main', enabled: true, status: 'ok', source: 'claude-oauth',
        fetchedAt: Date.now(), checkedAt: Date.now(), stale: false,
        windows: [{ id: '5h', label: '5h', usedPercent: 12, resetAt: Date.now() + 3_600_000 }] }] } } }),
    fetchFn: async (url, init) => {
      calls.push({ url, auth: init.headers.get('authorization'), launch: init.headers.get('x-unsnooze-launch'),
        session: init.headers.get('session_id'), body: init.body?.toString() });
      return new Response('data: {"type":"message_stop"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    },
    ...options });
  hostConfig(stateDir);
  return { ...proxy, stateDir, socket, calls, remote: { version: 1, socket, providers: ['claude', 'codex'] },
    url: `http://127.0.0.1:${proxy.port}`, token: routerToken(stateDir) };
}

async function devbox(remote, options = {}) {
  const stateDir = dir();
  const proxy = await startAccountProxy({ stateDir, port: 0,
    selectFn: async () => { throw new Error('local selection must not run in remote mode'); },
    credentialFn: async () => { throw new Error('local credentials must not be read in remote mode'); },
    ...options });
  if (remote) atomicPrivateJson(join(stateDir, 'accounts-remote.json'), remote);
  return { ...proxy, stateDir, url: `http://127.0.0.1:${proxy.port}`, token: routerToken(stateDir) };
}

test('host: trusted socket needs no token, TCP needs the router token, API never exposes credentials', async () => {
  const h = await host();
  try {
    const health = await remoteJson(h.remote, 'GET', '/health');
    assert.equal(health.service, 'unsnooze-accounts-host');
    assert.equal((await fetch(h.url + '/health')).status, 401);
    assert.equal((await fetch(h.url + '/health', { headers: { authorization: `Bearer ${h.token}` } })).status, 200);
    const view = await remoteJson(h.remote, 'GET', '/accounts/v1/accounts');
    assert.equal(view.providers.claude.accounts[0].id, 'claude-a');
    assert.equal(view.providers.codex.accounts[0].priority, 2);
    const text = JSON.stringify(view);
    assert.doesNotMatch(text, /credential|token|secret|\/never/);
    const selected = await remoteJson(h.remote, 'POST', '/accounts/v1/select', { provider: 'claude', refresh: true });
    assert.deepEqual(selected.account, { id: 'claude-a', name: 'Main', enabled: true, priority: 0 });
    assert.doesNotMatch(JSON.stringify(selected), /never|credential/);
    await assert.rejects(remoteJson(h.remote, 'POST', '/accounts/v1/select', { provider: 'claude', exclude: ['../x'] }), /400/);
    await assert.rejects(remoteJson(h.remote, 'POST', '/accounts/v1/select', { provider: 'evil' }), /400/);
    await assert.rejects(remoteJson(h.remote, 'GET', '/accounts/v1/credentials'), /404/);
    const usage = await remoteJson(h.remote, 'GET', '/accounts/v1/usage?refresh=1&probe=1');
    assert.deepEqual(usage.options.refresh, true);
    assert.deepEqual(usage.options.allowProbe, true);
  } finally { await h.close(); }
});

test('forwarder: local capability checked, never forwarded; provider token added only on the host', async () => {
  const h = await host();
  const d = await devbox(h.remote);
  try {
    assert.equal((await fetch(d.url + '/claude/v1/messages', { method: 'POST', body: '{}' })).status, 401);
    assert.equal(h.calls.length, 0);
    const launch = randomUUID();
    const body = JSON.stringify({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }], stream: true });
    const r = await fetch(d.url + '/claude/v1/messages?beta=true', { method: 'POST', body,
      headers: { authorization: `Bearer ${d.token}`, 'x-unsnooze-launch': launch, session_id: 'session-1', cookie: 'c=1' } });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /message_stop/);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].url, 'https://api.anthropic.com/v1/messages?beta=true');
    assert.equal(h.calls[0].auth, 'Bearer FAKE_PROVIDER_TOKEN');
    assert.equal(h.calls[0].launch, null);
    assert.equal(h.calls[0].session, 'session-1');
    assert.equal(h.calls[0].body, body);
    // agy is not routed and unknown paths are still refused locally.
    assert.equal((await fetch(d.url + '/codex/login', { headers: { authorization: `Bearer ${d.token}` } })).status, 404);
  } finally { await d.close(); await h.close(); }
});

test('forwarder: removing the remote file switches back to local routing without a restart', async () => {
  const h = await host();
  let local = 0;
  const d = await devbox(h.remote, { selectFn: async () => { local++; return { account: null, reason: 'unconfigured' }; } });
  try {
    const call = () => fetch(d.url + '/claude/v1/messages', { method: 'POST', body: '{}', headers: { authorization: `Bearer ${d.token}` } });
    assert.equal((await call()).status, 200);
    rmSync(join(d.stateDir, 'accounts-remote.json'));
    assert.equal((await call()).status, 503);
    assert.equal(local, 1);
    assert.equal(h.calls.length, 1);
  } finally { await d.close(); await h.close(); }
});

test('forwarder: host resume refusal becomes a local resume request; host outage is a 502', async () => {
  const h = await host({ selectFn: async () => ({ account: { id: 'codex-b' } }) });
  const d = await devbox(h.remote);
  try {
    const launch = randomUUID();
    // Seed the host affinity with another account, as a switch would leave it.
    const first = await fetch(d.url + '/codex/responses', { method: 'POST', body: '{}',
      headers: { authorization: `Bearer ${d.token}`, 'x-unsnooze-launch': launch, session_id: 'chain-1' } });
    assert.equal(first.status, 200);
    await first.text();
    await h.close();
    const h2 = await startAccountProxy({ stateDir: h.stateDir, api: true, listeners: [{ path: h.socket, trusted: true }],
      selectFn: async () => ({ account: { id: 'codex-c' } }), credentialFn: async () => ({ accessToken: 'x', accountId: 'y' }),
      failureFn: async () => {}, usageHeadersFn: async () => {}, fetchFn: async () => new Response('{}') });
    try {
      const r = await fetch(d.url + '/codex/responses', { method: 'POST', body: JSON.stringify({ previous_response_id: 'resp_1' }),
        headers: { authorization: `Bearer ${d.token}`, 'x-unsnooze-launch': launch, session_id: 'chain-1' } });
      assert.equal(r.status, 409);
      assert.equal((await r.json()).error.code, 'session_resume_required');
      const request = readResumeRequest(launch, d.stateDir);
      assert.equal(request.sessionId, 'chain-1');
      assert.equal(request.provider, 'codex');
      assert.equal(request.phase, 'pending');
    } finally { await h2.close(); }
    const down = await fetch(d.url + '/claude/v1/messages', { method: 'POST', body: '{}', headers: { authorization: `Bearer ${d.token}` } });
    assert.equal(down.status, 502);
    assert.match(await down.text(), /Account host unavailable/);
  } finally { await d.close(); }
});

test('remote selection and usage come from the host; an outage holds instead of waking', async () => {
  const h = await host();
  const stateDir = dir();
  try {
    await enableRemote(stateDir, { socket: h.socket });
    const config = readAccounts(stateDir);
    assert.equal(config.providers.claude.accounts[0].credential.type, 'remote');
    assert.equal(config.providers.codex.accounts[0].credential.path, h.socket);
    assert.throws(() => readCredential(config.providers.claude.accounts[0]), e => e.code === 'credential_unavailable');
    const selected = await selectRoutingAccount('claude', { stateDir, refresh: true });
    assert.equal(selected.account.id, 'claude-a');
    assert.equal(selected.account.credential.type, 'remote');
    const usage = await fetchUsageSnapshot({ stateDir, refresh: true });
    assert.equal(usage.providers.claude.accounts[0].status, 'ok');
    assert.equal(usage.providers.claude.accounts[0].windows[0].usedPercent, 12);
  } finally { await h.close(); }
  const held = await selectRoutingAccount('claude', { stateDir });
  assert.equal(held.account, null);
  assert.equal(held.status, 'network_error');
  const usage = await fetchUsageSnapshot({ stateDir, refresh: true });
  assert.equal(usage.providers.claude.accounts[0].status, 'network_error');
  assert.equal(usage.providers.codex.accounts[0].stale, true);
});

test('enable keeps the local references once; disable restores them and leaves agy local', async () => {
  const h = await host();
  const stateDir = dir();
  try {
    const local = emptyAccounts();
    local.providers.claude.accounts.push({ id: 'claude-a', name: 'Main', priority: 0, enabled: true,
      credential: { type: 'claude-token', path: '/home/dev/.unsnooze/credentials/claude.token' } });
    local.providers.agy.accounts.push({ id: 'agy-a', name: 'Agy', priority: 0, enabled: true,
      credential: { type: 'agy-token', path: '/home/dev/.gemini/antigravity-cli/antigravity-oauth-token' } });
    saveAccounts(local, stateDir);
    await enableRemote(stateDir, { socket: h.socket });
    await enableRemote(stateDir, { socket: h.socket });
    assert.equal(readRemoteConfig(stateDir).providers.join(), 'claude,codex');
    assert.equal(readAccounts(stateDir).providers.agy.accounts[0].credential.type, 'agy-token');
    assert.equal(await syncRemoteAccounts(stateDir), false);
    assert.equal(await cmdAccounts(['disable', 'claude', 'claude-a', '--state-dir', stateDir]), 1);
    assert.equal(await cmdAccounts(['import', 'codex', '--state-dir', stateDir]), 1);
    assert.equal(await cmdAccounts(['remote', 'status', '--state-dir', stateDir]), 0);
    assert.equal((await disableRemote(stateDir)).restored, true);
    assert.equal(readRemoteConfig(stateDir), null);
    const restored = readAccounts(stateDir);
    assert.equal(restored.providers.claude.accounts[0].credential.type, 'claude-token');
    assert.equal(restored.providers.codex.accounts.length, 0);
    assert.equal(restored.providers.agy.accounts[0].id, 'agy-a');
  } finally { await h.close(); }
});

test('enable refuses a socket that is not an account host, and invalid remote configs', async () => {
  const d = await devbox(null);
  const stateDir = dir();
  try {
    await assert.rejects(enableRemote(stateDir, { socket: join(root, 'missing.sock') }), /unavailable/);
    assert.equal(existsSync(join(stateDir, 'accounts-remote.json')), false);
    for (const bad of [{ version: 1, socket: 'relative', providers: ['claude'] },
      { version: 1, socket: '/s', providers: ['agy'] }, { version: 1, socket: '/s', providers: [] },
      { version: 1, socket: '/s', providers: ['claude'], extra: true }]) {
      assert.throws(() => validateRemoteConfig(bad), /invalid/);
    }
  } finally { await d.close(); }
});

test('host listeners: systemd fds by name, LISTEN_PID guard, fallbacks; refuses a remote state dir', async () => {
  assert.deepEqual(systemdListeners({ LISTEN_FDS: '2', LISTEN_PID: '7', LISTEN_FDNAMES: 'devbox:host' }, 7),
    [{ fd: 3, name: 'devbox' }, { fd: 4, name: 'host' }]);
  assert.deepEqual(systemdListeners({ LISTEN_FDS: '2', LISTEN_PID: '8' }, 7), []);
  assert.deepEqual(hostListeners({ LISTEN_FDS: '2', LISTEN_PID: '7', LISTEN_FDNAMES: 'devbox:host' }, 7)
    .map(l => [l.fd, l.trusted]), [[3, true], [4, false]]);
  assert.deepEqual(hostListeners({ UNSNOOZE_HOST_SOCKET: '/run/x.sock', UNSNOOZE_ROUTER_PORT: '18486' }, 7)
    .map(l => [l.path ?? l.port, l.trusted]), [['/run/x.sock', true], [18486, false]]);
  assert.deepEqual(hostListeners({ LISTEN_FDS: '1', LISTEN_PID: '7', LISTEN_FDNAMES: 'devbox',
    UNSNOOZE_HOST_TRUSTED_LISTENERS: '' }, 7)[0].trusted, false);
  const stateDir = dir();
  atomicPrivateJson(join(stateDir, 'accounts-remote.json'), { version: 1, socket: '/s', providers: ['claude'] });
  await assert.rejects(runHostRouter({ stateDir, env: { UNSNOOZE_ROUTER_PORT: '0' } }), /remote mode/);
  await assert.rejects(startAccountProxy({ stateDir, api: true, port: 0 }), /cannot itself forward/);
  await assert.rejects(runHostRouter({ stateDir: dir(), env: {} }), /No listener/);
});

test('host router runs from env listeners and stops on abort', async () => {
  const stateDir = dir();
  hostConfig(stateDir);
  const controller = new AbortController();
  const socket = stateDir + '-host.sock';
  let started;
  const run = runHostRouter({ stateDir, env: { UNSNOOZE_HOST_SOCKET: socket }, signal: controller.signal, log: () => {},
    startProxy: async options => { started = await startAccountProxy(options); return started; } });
  for (let i = 0; i < 100 && !started; i++) await new Promise(r => setTimeout(r, 10));
  const health = await remoteJson({ socket }, 'GET', '/health');
  assert.equal(health.service, 'unsnooze-accounts-host');
  assert.match(health.version, /\d/);
  controller.abort();
  assert.equal(await run, 0);
});
