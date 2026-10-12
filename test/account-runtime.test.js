import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicPrivateJson, readPrivateJson } from '../src/accounts/store.js';
import { routingCredential } from '../src/accounts/refresh.js';
import { managedLaunchOptions } from '../src/accounts/launch.js';
import { accountResumeGate } from '../src/accounts/gate.js';
import { agyResumeArgs, installAgyCredential, saveAgyCredential } from '../src/accounts/agy.js';
import { emptyAccounts, saveAccounts, readAccounts } from '../src/accounts/config.js';
import { selectRoutingAccount, recordAccountFailure } from '../src/accounts/routing.js';

const dir = mkdtempSync(join(tmpdir(), 'unsnooze-runtime-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('only managed credential owner refreshes, concurrent sessions consume refresh once', async () => {
  const path = join(dir, 'credential.json');
  const account = { credential: { type: 'managed', path } };
  atomicPrivateJson(path, { accessToken: 'old-access', refreshToken: 'refresh-once', expiresAt: Date.now() - 1, accountId: 'account' });
  let calls = 0;
  const fetchFn = async (_url, opts) => { calls++; assert.equal(JSON.parse(opts.body).refresh_token, 'refresh-once');
    return new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 })); };
  const credentials = await Promise.all(Array.from({ length: 5 }, () => routingCredential('codex', account, { fetchFn })));
  assert.equal(calls, 1); assert.ok(credentials.every(c => c.accessToken === 'new-access'));
  assert.equal(readPrivateJson(path).refreshPending, undefined);
});

test('uncertain OAuth response or crash intent never reuses refresh token', async () => {
  const path = join(dir, 'uncertain.json');
  atomicPrivateJson(path, { accessToken: 'old', refreshToken: 'single-use', expiresAt: Date.now() - 1 });
  const a = { credential: { type: 'managed', path } }; let calls = 0;
  const fetchFn = async () => { calls++; throw new Error('DO_NOT_LOG_SECRET'); };
  await assert.rejects(routingCredential('codex', a, { fetchFn }), e => e.code === 'network_error' && !e.message.includes('SECRET'));
  await assert.rejects(routingCredential('codex', a, { fetchFn }), e => e.code === 'expired_login');
  assert.equal(calls, 1); assert.ok(readPrivateJson(path).refreshPending);
});

test('external expired agy and Codex tokens never invoke token endpoint', async () => {
  const path = join(dir, 'external.json');
  atomicPrivateJson(path, { token: { access_token: 'old', refresh_token: 'native-only', expiry: new Date(0).toISOString() } });
  let called = false;
  await assert.rejects(routingCredential('agy', { credential: { type: 'agy-token', path } }, {
    fetchFn: async () => { called = true; },
  })); assert.equal(called, false);
});

test('launcher keeps exact resume ID and secrets out of argv while bypassing old router', () => {
  const codex = managedLaunchOptions('codex', ['resume', 'same-session'], { port: 18484, token: 'LOCAL_CAPABILITY',
    env: { UNSNOOZE_CODEX_BIN: 'mcodex' } });
  assert.deepEqual(codex.args.slice(-2), ['resume', 'same-session']);
  assert.ok(!codex.args.join(' ').includes('LOCAL_CAPABILITY'));
  assert.equal(codex.env.UNSNOOZE_CODEX_BIN, 'codex');
  const claude = managedLaunchOptions('claude', ['--resume', 'same-session'], { port: 18484, token: 'LOCAL_CAPABILITY',
    env: { ANTHROPIC_API_KEY: 'OLD_SECRET', ANTHROPIC_AUTH_TOKEN: 'OLD_SECRET' } });
  assert.equal(claude.env.ANTHROPIC_API_KEY, undefined);
  assert.deepEqual(claude.args, ['--resume', 'same-session']);
});

test('resume is held for auth/network/unverified usage without changing session identity', async () => {
  const record = { agent: 'codex', sessionId: 'same', detectedAt: 100, bannerAt: 200 };
  for (const reason of ['expired_login', 'network_error', 'all_exhausted']) {
    const result = await accountResumeGate(record, { configuredFn: () => true,
      selectFn: async (_p, options) => { assert.equal(options.minFetchedAt, 200); return { account: null, reason }; } });
    assert.equal(result.ready, false); assert.equal(record.sessionId, 'same');
  }
});

test('Antigravity swaps native files preserving refreshed token and exact conversation ID', () => {
  const source = join(dir, 'agy-source.json'), native = join(dir, 'agy-native.json');
  const account = { credential: { type: 'agy-token', path: source } };
  atomicPrivateJson(source, { token: { access_token: 'initial' } });
  installAgyCredential(account, native);
  atomicPrivateJson(native, { token: { access_token: 'native-refreshed' } });
  saveAgyCredential(account, native);
  assert.equal(readPrivateJson(source).token.access_token, 'native-refreshed');
  assert.deepEqual(agyResumeArgs('conversation-123'), ['--conversation', 'conversation-123']);
  assert.throws(() => agyResumeArgs(null));
});

test('concurrent routing decisions commit one account; live check clears stale blocks after restart', async () => {
  const stateDir = join(dir, 'routing'); const now = Date.now();
  const config = emptyAccounts();
  config.providers.codex.accounts = ['a', 'b'].map(id => ({ id, name: id, priority: 0, enabled: true,
    credential: { type: 'managed', path: join(dir, `${id}.json`) } }));
  config.providers.codex.activeAccountId = 'a';
  config.providers.codex.policy.cooldownMs = 0;
  saveAccounts(config, stateDir);
  const snapshot = (at, used) => ({ providers: { codex: { accounts: ['a', 'b'].map(id => ({ id, status: 'ok',
    fetchedAt: at, windows: [{ id: 'weekly', usedPercent: id === 'a' ? used : 10, resetAt: at + 1000 }] })) } } });
  const usageFn = async () => snapshot(now, 99);
  const choices = await Promise.all([1, 2].map(() => selectRoutingAccount('codex', { stateDir, now, usageFn })));
  assert.ok(choices.every(c => c.account.id === 'b'));
  assert.equal(readAccounts(stateDir).providers.codex.activeAccountId, 'b');
  await recordAccountFailure('codex', 'b', 'quota_exhausted', { stateDir, now });
  const held = await selectRoutingAccount('codex', { stateDir, now, usageFn: async () => snapshot(now, 100) });
  assert.equal(held.account, null);
  const recovered = await selectRoutingAccount('codex', { stateDir, now: now + 1, usageFn: async () => snapshot(now + 1, 0) });
  assert.ok(recovered.account);
});
