import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runManagedAgy, recoverAgySlot, agyOwnerAlive, agyIdleConversation } from '../src/accounts/agy.js';
import { atomicPrivateJson, readPrivateJson } from '../src/accounts/store.js';
import { emptyAccounts, saveAccounts, readAccounts } from '../src/accounts/config.js';

const root = mkdtempSync(join(tmpdir(), 'unsnooze-native-agy-'));
after(() => rmSync(root, { recursive: true, force: true }));
let sequence = 0;
function setup() {
  const dir = join(root, String(sequence++));
  const accounts = ['a', 'b'].map(id => ({ id, name: id, enabled: true, priority: 0,
    credential: { type: 'agy-token', path: join(dir, `${id}.json`) } }));
  for (const a of accounts) atomicPrivateJson(a.credential.path, { token: { access_token: a.id,
    refresh_token: `native-${a.id}`, expiry: new Date(Date.now() + 3600000).toISOString() } });
  const config = emptyAccounts(); config.providers.agy.accounts = accounts; config.providers.agy.activeAccountId = 'a';
  saveAccounts(config, dir);
  const nativePath = join(dir, 'native.json'); atomicPrivateJson(nativePath, { token: { access_token: 'untouched' } });
  return { dir, accounts, nativePath };
}

test('quota/pin/network holds never bypass selection or overwrite native credentials', async () => {
  for (const reason of ['all_exhausted', 'pinned_unavailable', 'network_error', 'on_limit_disabled']) {
    const f = setup(); let launches = 0;
    await assert.rejects(runManagedAgy([], { stateDir: f.dir, nativePath: f.nativePath,
      selectFn: async () => ({ account: null, reason }), launchFn: async () => { launches++; },
      readStateFn: () => ({ sessions: {} }), updateStateFn: () => {}, ownerAliveFn: () => false }));
    assert.equal(launches, 0); assert.equal(readPrivateJson(f.nativePath).token.access_token, 'untouched');
  }
});

test('limit -> native credential switch -> exact conversation and continuation, including headless metadata', async () => {
  const f = setup(), calls = []; const state = { sessions: {} }; let choices = 0;
  const result = await runManagedAgy(['--model', 'gemini-model'], { stateDir: f.dir, nativePath: f.nativePath,
    intervalMs: 5, ownerAliveFn: () => false,
    selectFn: async () => ({ account: f.accounts[choices++ ? 1 : 0] }),
    readStateFn: () => state, updateStateFn: fn => fn(state),
    launchFn: async (args, provider, options) => {
      calls.push({ args, provider, token: readPrivateJson(f.nativePath).token.access_token });
      const lease = { leaseId: `lease-${calls.length}`, pid: 1234, pidBirth: 'fake', mux: 'headless', pane: null, paneOwner: null };
      if (calls.length > 1) { options.onChild({ kill() {} }, lease); return 0; }
      return new Promise(resolve => {
        const keepAlive = setInterval(() => {}, 100);
        options.onChild({ kill: () => { clearInterval(keepAlive); resolve(1); } }, lease);
        atomicPrivateJson(f.nativePath, { token: { access_token: 'native-refreshed-a' } });
        state.sessions.stop = { key: 'stop', agent: 'agy', sessionId: 'same-conversation', detectedAt: Date.now(),
          leaseId: lease.leaseId, status: 'stopped' };
      });
    },
  });
  assert.equal(result, 0); assert.deepEqual(calls.map(c => c.token), ['a', 'b']);
  assert.ok(calls[1].args.includes('same-conversation')); assert.ok(calls[1].args.includes('--prompt-interactive'));
  assert.equal(readPrivateJson(f.accounts[0].credential.path).token.access_token, 'native-refreshed-a');
  assert.equal(state.sessions.stop.status, 'resuming');
  assert.equal(state.sessions.stop.sessionId, 'same-conversation');
});

test('crash recovery saves the latest native token before any replacement and refuses a live orphan', () => {
  const f = setup();
  const journal = { version: 1, phase: 'running', launchNonce: randomUUID(), account: f.accounts[0] };
  atomicPrivateJson(f.nativePath, { token: { access_token: 'latest-after-crash' } });
  assert.throws(() => recoverAgySlot(journal, f.nativePath, { aliveFn: () => true }), /still running/);
  assert.equal(readPrivateJson(f.accounts[0].credential.path).token.access_token, 'a');
  recoverAgySlot(journal, f.nativePath, { aliveFn: () => false });
  assert.equal(readPrivateJson(f.accounts[0].credential.path).token.access_token, 'latest-after-crash');
  atomicPrivateJson(f.nativePath, { token: { access_token: 'ambiguous-before-install' } });
  recoverAgySlot({ ...journal, phase: 'installing' }, f.nativePath, { aliveFn: () => false });
  assert.equal(readPrivateJson(f.accounts[0].credential.path).token.access_token, 'latest-after-crash');
});

test('unpublished child is detected by durable nonce; PID recycling is not ownership', () => {
  const nonce = randomUUID();
  const journal = { phase: 'prepared', launchNonce: nonce, child: null };
  const options = { platform: 'linux', readdir: () => ['12'], stat: () => ({ uid: process.getuid() }),
    readFile: path => path.endsWith('/stat') ? '12 (agy) S 0' : `UNSNOOZE_AGY_LAUNCH_NONCE=${nonce}\0` };
  assert.equal(agyOwnerAlive(journal, options), true);
  assert.equal(agyOwnerAlive({ ...journal, child: { pid: 12, pidBirth: 'old' } }, {
    ...options, birthFn: () => 'recycled', readFile: path => path.endsWith('/stat') ? '12 (other) S 0' : 'other=1',
  }), false);
});

test('a sole imported expired account can let its native CLI refresh without OAuth extraction', async () => {
  const f = setup();
  const config = readAccounts(f.dir);
  config.providers.agy.accounts = [f.accounts[0]];
  config.providers.agy.activeAccountId = null;
  saveAccounts(config, f.dir);
  atomicPrivateJson(f.accounts[0].credential.path, { token: { access_token: 'expired', expiry: Date.now() - 1000 } });
  let calls = 0;
  assert.equal(await runManagedAgy([], { stateDir: f.dir, nativePath: f.nativePath,
    selectFn: async () => ({ account: null, reason: 'no_available_account' }), ownerAliveFn: () => false,
    launchFn: async () => {
      calls++; assert.equal(readPrivateJson(f.nativePath).token.access_token, 'expired');
      atomicPrivateJson(f.nativePath, { token: { access_token: 'native-refreshed', expiry: Date.now() + 3600000 } });
      return 0;
    }, readStateFn: () => ({ sessions: {} }), updateStateFn: () => {},
  }), 0);
  assert.equal(calls, 1);
  assert.equal(readAccounts(f.dir).providers.agy.activeAccountId, 'a');
  assert.equal(readPrivateJson(f.accounts[0].credential.path).token.access_token, 'native-refreshed');
});

test('idle threshold handoff waits for a stable composer then resumes the same conversation', async () => {
  const f = setup(); let choices = 0, idles = 0; const calls = [];
  const result = await runManagedAgy(['--conversation', 'threshold-session'], {
    stateDir: f.dir, nativePath: f.nativePath, intervalMs: 5, ownerAliveFn: () => false,
    selectFn: async () => ({ account: f.accounts[choices++ ? 1 : 0] }),
    idleFn: async () => { idles++; return { sessionId: 'threshold-session', signature: 'stable-empty-composer' }; },
    readStateFn: () => ({ sessions: {} }), updateStateFn: () => {},
    launchFn: async (args, provider, options) => {
      calls.push(args);
      if (calls.length > 1) return 0;
      return new Promise(resolve => {
        const keepAlive = setInterval(() => {}, 100);
        options.onChild({ kill: () => { clearInterval(keepAlive); resolve(1); } }, { leaseId: 'native-threshold' });
      });
    },
  });
  assert.equal(result, 0); assert.equal(calls.length, 2); assert.ok(idles >= 3);
  assert.ok(calls[1].includes('threshold-session'));
  assert.equal(readPrivateJson(f.nativePath).token.access_token, 'b');
});

test('threshold readiness rejects busy, draft, unowned and unidentified panes', async () => {
  const lease = { pane: '%1', mux: 'tmux' };
  const options = { matchesLease: async () => true, ownsPane: async () => true,
    latestSessionId: () => 'identified-session', mux: { capturePaneVisible: async () => 'Answer\n❯ ' } };
  assert.equal((await agyIdleConversation(lease, options)).sessionId, 'identified-session');
  for (const text of ['Answer\n❯ unfinished draft', '>\nAnswer\n❯ unfinished draft', 'esc to interrupt\n❯ ', 'unknown screen']) {
    assert.equal(await agyIdleConversation(lease, { ...options, mux: { capturePaneVisible: async () => text } }), null);
  }
  assert.equal(await agyIdleConversation(lease, { ...options, ownsPane: async () => false }), null);
  assert.equal(await agyIdleConversation(lease, { ...options, matchesLease: async () => false }), null);
  assert.equal(await agyIdleConversation(lease, { ...options, latestSessionId: () => null }), null);
  assert.equal(await agyIdleConversation({ pane: null }, options), null);
});
