import test from 'node:test';
import assert from 'node:assert/strict';
import { reconciliationPatches, reconcileAccountSessions } from '../src/accounts/reconcile.js';

const NOW = 1_800_000_000_000;
const profile = (extra = {}) => ({ accounts: [{ id: 'a', enabled: true, priority: 0 }, { id: 'b', enabled: true, priority: 0 }],
  activeAccountId: 'a', policy: { thresholdPercent: 95, onLimit: true }, ...extra });
const reading = (id, extra = {}) => ({ id, enabled: true, status: 'ok', stale: false, fetchedAt: NOW,
  windows: [{ id: 'five-hour', usedPercent: 20, resetAt: NOW + 300_000 }, { id: 'weekly', usedPercent: 60, resetAt: NOW + 500_000 }], ...extra });
const session = (extra = {}) => ({ status: 'stopped', agent: 'claude', resetAt: NOW + 60_000,
  detectedAt: NOW - 5_000, bannerAt: NOW - 5_000, sessionId: 'original-session', cwd: '/original-workspace',
  workspace: { branch: 'original' }, leaseId: 'original-lease', pane: '%1', attempts: 2,
  pid: 123, pidBirth: 'birth', ...extra });

function run({ config = profile(), usage = [reading('a'), reading('b')], sessions = { waiting: session() } } = {}) {
  return reconciliationPatches({ sessions }, { providers: { claude: config } },
    { providers: { claude: { accounts: usage } } }, { now: NOW });
}

test('fresh measured capacity advances only the same configured stopped session', async () => {
  const waiting = session();
  const untouched = {
    running: session({ status: 'resuming' }), failed: session({ status: 'failed' }),
    cancelled: session({ status: 'cancelled' }), resumed: session({ status: 'resumed' }),
    other: session({ agent: 'codex' }), past: session({ resetAt: NOW - 1 }),
  };
  const state = { sessions: { waiting, ...structuredClone(untouched) } };
  const before = structuredClone(waiting);
  const result = await reconcileAccountSessions({ now: NOW,
    accounts: { providers: { claude: profile() } },
    snapshot: { providers: { claude: { accounts: [reading('a')] } } },
    updateState: fn => fn(state),
  });
  assert.deepEqual(result.changed, ['waiting']);
  assert.deepEqual(waiting, { ...before, resetAt: NOW, resetSource: 'account-usage', usageReconciledAt: NOW });
  for (const [key, value] of Object.entries(untouched)) assert.deepEqual(state.sessions[key], value);
});

test('expired, failed, unknown, stale, and unverified usage never advances reset timers', () => {
  for (const patch of [
    { status: 'expired_login' }, { status: 'network_error' }, { status: 'unknown' },
    { status: 'quota_exhausted' }, { stale: true }, { stale: undefined },
    { fetchedAt: NOW - 60_001 }, { fetchedAt: NOW + 1 }, { windows: [] },
    { windows: [{ id: 'weekly', usedPercent: 100, resetAt: NOW - 1 }] },
    { windows: [{ id: 'weekly', usedPercent: null }] },
    { windows: [{ id: 'weekly', usedPercent: NaN }] },
  ]) assert.deepEqual(run({ usage: [reading('a', patch)] }), [], JSON.stringify(patch));
});

test('an older usage success cannot clear a newer limit episode', () => {
  assert.deepEqual(run({ usage: [reading('a', { fetchedAt: NOW - 6_000 })] }), []);
  assert.deepEqual(run({ sessions: { missing: session({ bannerAt: undefined, detectedAt: undefined }) } }), []);
});

test('pin, never-switch, no-on-limit and current auth failure remain routing gates', () => {
  const exhausted = reading('a', { status: 'quota_exhausted' });
  const good = reading('b');
  assert.deepEqual(run({ config: profile({ pinnedAccountId: 'a' }), usage: [exhausted, good] }), []);
  assert.deepEqual(run({ config: profile({ policy: { neverSwitch: true } }), usage: [exhausted, good] }), []);
  assert.deepEqual(run({ config: profile({ policy: { onLimit: false } }), usage: [exhausted, good] }), []);
  assert.deepEqual(run({ usage: [reading('a', { status: 'expired_login' }), good] }), []);
  assert.deepEqual(run({ config: profile({ accounts: [{ id: 'a', enabled: false }] }) }), []);
  assert.equal(run({ usage: [exhausted, good] }).length, 1);
});

test('threshold alone does not prohibit an otherwise usable pinned account', () => {
  const usage = [reading('a', { windows: [{ id: 'weekly', usedPercent: 97 }] })];
  assert.equal(run({ config: profile({ pinnedAccountId: 'a' }), usage }).length, 1);
});

test('a concurrent new stop is evaluated under the upstream state lock', async () => {
  const current = { sessions: { waiting: session({ bannerAt: NOW + 1 }) } };
  const result = await reconcileAccountSessions({ now: NOW,
    accounts: { providers: { claude: profile() } },
    snapshot: { providers: { claude: { accounts: [reading('a')] } } },
    updateState: fn => fn(current),
  });
  assert.deepEqual(result.changed, []);
  assert.equal(current.sessions.waiting.resetAt, NOW + 60_000);
});

test('refresh failure never writes session state', async () => {
  let writes = 0;
  await assert.rejects(reconcileAccountSessions({
    accounts: { providers: { claude: profile() } },
    fetchUsageSnapshot: async () => { throw new Error('offline'); },
    updateState: () => { writes++; },
  }), /offline/);
  assert.equal(writes, 0);
});
