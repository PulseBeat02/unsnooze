import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseAccount } from '../src/accounts/select.js';
import { DEFAULT_POLICY, ACCOUNT_USAGE_MAX_AGE_MS } from '../src/accounts/config.js';

const NOW = 1_000_000;
const account = (id, priority = 0, enabled = true) => ({ id, priority, enabled });
const usage = (usedPercent, overrides = {}) => ({ status: 'ok', fetchedAt: NOW,
  windows: [{ id: 'short', usedPercent, resetAt: NOW + 5_000 }], ...overrides });
const section = (overrides = {}) => ({ accounts: [account('a'), account('b'), account('c')],
  activeAccountId: 'a', pinnedAccountId: null, policy: { ...DEFAULT_POLICY }, ...overrides });
const select = (config, map, options) => chooseAccount(config, map, { now: NOW, ...options });

test('a healthy current account stays sticky while initial selection prefers headroom', () => {
  const config = section();
  const map = { a: usage(40), b: usage(10), c: usage(20) };
  assert.equal(select(config, map).account.id, 'a');
  assert.equal(select(config, map, { currentId: null }).account.id, 'b');
  assert.equal(select(config, new Map(Object.entries(map)), { currentId: null }).account.id, 'b');
});

test('threshold switches to available headroom but serves current if there is none', () => {
  const config = section();
  assert.equal(select(config, { a: usage(95), b: usage(30), c: usage(10) }).account.id, 'c');
  assert.equal(select(config, { a: usage(98), b: usage(100), c: usage(100) }).account.id, 'a');
  assert.equal(select(config, { a: usage(100), b: usage(100), c: usage(100) }).account, null);
});

test('all quota windows participate in headroom and exhaustion', () => {
  const a = usage(10, { windows: [{ id: 'short', usedPercent: 10, resetAt: NOW + 5_000 }, { id: 'week', usedPercent: 100, resetAt: NOW + 50_000 }] });
  assert.equal(select(section(), { a, b: usage(50), c: usage(20) }).account.id, 'c');
});

test('pins and neverSwitch keep a fresh usable account above threshold', () => {
  const map = { a: usage(98), b: usage(1), c: usage(2) };
  assert.equal(select(section({ pinnedAccountId: 'a' }), map).account.id, 'a');
  assert.equal(select(section({ policy: { ...DEFAULT_POLICY, neverSwitch: true } }), map).account.id, 'a');
  map.a = usage(100);
  assert.equal(select(section({ pinnedAccountId: 'a' }), map).reason, 'pinned_unavailable');
  assert.equal(select(section({ policy: { ...DEFAULT_POLICY, neverSwitch: true } }), map).account, null);
});

test('live limit excludes current despite a previously healthy measurement', () => {
  const map = { a: usage(0), b: usage(20), c: usage(30) };
  for (const reason of ['limit', 'quota_exhausted']) assert.equal(select(section(), map, { reason }).account.id, 'b');
  assert.equal(select(section({ pinnedAccountId: 'a' }), map, { reason: 'limit' }).account, null);
});

test('onLimit false holds actual exhaustion while threshold rotation remains allowed', () => {
  const config = section({ policy: { ...DEFAULT_POLICY, onLimit: false } });
  assert.equal(select(config, { a: usage(100), b: usage(0) }).reason, 'on_limit_disabled');
  assert.equal(select(config, { a: usage(95), b: usage(0) }).account.id, 'b');
});

test('cooldown blocks threshold churn, while hard quota bypasses it', () => {
  const options = { lastSwitchAt: NOW - 10 };
  const threshold = select(section(), { a: usage(95), b: usage(0) }, options);
  assert.equal(threshold.account.id, 'a');
  assert.equal(threshold.reason, 'cooldown');
  assert.equal(threshold.retryAt, NOW - 10 + DEFAULT_POLICY.cooldownMs);
  assert.equal(select(section(), { a: usage(100), b: usage(0) }, options).account.id, 'b');
  assert.equal(select(section(), { a: usage(100), b: usage(0) }, { lastSwitchAt: NOW - DEFAULT_POLICY.cooldownMs }).account.id, 'b');
});

test('remaining headroom above the threshold remains usable after a hard limit', () => {
  const config = section();
  assert.equal(select(config, { a: usage(100), b: usage(99), c: usage(97) }).account.id, 'c');
  assert.equal(select(config, { a: usage(10), b: usage(99), c: usage(97) }, { reason: 'limit' }).account.id, 'c');
});

test('unavailable/auth errors are not quota signals and never qualify a replacement', () => {
  for (const status of ['expired_login', 'network_error', 'unknown']) {
    const output = select(section(), { a: usage(50, { status }), b: usage(0) });
    assert.equal(output.account, null);
    assert.equal(output.reason, status);
    const replacement = select(section(), { a: usage(100), b: usage(0, { status }), c: usage(10) });
    assert.equal(replacement.account.id, 'c');
  }
});

test('stale, future, malformed and missing successful measurements do not qualify', () => {
  for (const sample of [undefined, usage(0, { fetchedAt: NOW - ACCOUNT_USAGE_MAX_AGE_MS - 1 }), usage(0, { fetchedAt: NOW + 1 }),
    usage(0, { stale: true }), usage(0, { windows: [] }), usage(0, { windows: [{ id: 'x', usedPercent: NaN }] }),
    usage(0, { windows: [{ id: 'x', usedPercent: -1 }] }), usage(0, { windows: [{ id: 'x', usedPercent: 101 }] }),
    usage(0, { windows: [{ id: 'x', usedPercent: 0, resetAt: 'later' }] })]) {
    assert.equal(select(section(), { a: usage(100), b: sample, c: usage(1) }).account.id, 'c');
  }
});

test('reset time is a retry hint only; exhaustion never clears from time passing', () => {
  const config = section({ accounts: [account('a'), account('b')] });
  const map = { a: usage(100, { status: 'quota_exhausted', windows: [{ id: 's', usedPercent: 100, resetAt: NOW - 1 }] }),
    b: usage(100, { status: 'quota_exhausted' }) };
  let result = select(config, map);
  assert.equal(result.account, null);
  assert.equal(result.reason, 'all_exhausted');
  assert.equal(result.retryAt, NOW);
  result = select(config, map, { now: NOW + 1_000_000 });
  assert.equal(result.account, null);
  assert.equal(result.reason, 'all_exhausted');
  map.b = usage(10);
  assert.equal(select(config, map).account.id, 'b', 'only a live successful replacement clears exhaustion');
});

test('priority and round-robin policies rank eligible accounts; disabled and excluded stay out', () => {
  const config = section({ accounts: [account('a'), account('b', 9), account('c', 1)] });
  const map = { a: usage(100), b: usage(30), c: usage(10) };
  assert.equal(select(config, map).account.id, 'c');
  config.policy.strategy = 'priority';
  assert.equal(select(config, map).account.id, 'b');
  config.policy.strategy = 'round-robin';
  assert.equal(select(config, map).account.id, 'b');
  assert.equal(select(config, map, { exclude: ['b'] }).account.id, 'c');
  config.accounts[1].enabled = false;
  assert.equal(select(config, map).account.id, 'c');
});

test('selection never mutates config or usage, and empty configuration returns no account', () => {
  const config = section(), map = { a: usage(100), b: usage(20) };
  const before = JSON.stringify({ config, map });
  select(config, map, { reason: 'limit' });
  assert.equal(JSON.stringify({ config, map }), before);
  assert.equal(select(section({ accounts: [] }), {}).account, null);
  assert.equal(select(null, {}).reason, 'invalid_config');
});
