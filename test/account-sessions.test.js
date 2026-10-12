import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { claimSessionAccount, readResumeRequest, runRoutedConversation, exactResumeArgs } from '../src/accounts/sessions.js';
import { scopeUsage } from '../src/accounts/scope.js';

const dir = mkdtempSync(join(tmpdir(), 'unsnooze-affinity-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('threshold switch at attempt zero cannot forward an account-bound response chain', async () => {
  const launchId = randomUUID();
  const headers = { session_id: 'same-saved-session', 'x-unsnooze-launch': launchId };
  assert.equal(await claimSessionAccount('codex', 'a', headers, { stateDir: dir }), true);
  assert.equal(await claimSessionAccount('codex', 'a', headers, { stateDir: dir, chained: true }), true);
  assert.equal(await claimSessionAccount('codex', 'b', headers, { stateDir: dir, chained: true }), false);
  assert.equal(readResumeRequest(launchId, dir).sessionId, 'same-saved-session');
  assert.equal(await claimSessionAccount('codex', 'b', headers, { stateDir: dir }), true);
});

test('managed loop consumes switch intent, stops only its child and resumes exact saved session', async () => {
  const launchId = randomUUID(), calls = [];
  const headers = { session_id: 'the-session', 'x-unsnooze-launch': launchId };
  const result = await runRoutedConversation('codex', [], { stateDir: dir, launchId, intervalMs: 5,
    buildOptions: args => ({ args, env: {} }),
    run: async (args, provider, options) => {
      calls.push({ args, provider });
      if (calls.length > 1) return 0;
      return new Promise(resolve => {
        const keepAlive = setInterval(() => {}, 100);
        options.onChild({ kill: signal => { assert.equal(signal, 'SIGTERM'); clearInterval(keepAlive); resolve(1); } });
        claimSessionAccount('codex', 'a', headers, { stateDir: dir })
          .then(() => claimSessionAccount('codex', 'b', headers, { stateDir: dir, chained: true }));
      });
    },
  });
  assert.equal(result, 0);
  assert.deepEqual(calls[1].args.slice(0, 2), ['resume', 'the-session']);
  assert.equal(readResumeRequest(launchId, dir).phase, 'resuming');
});

test('missing/invalid session identities never become shell or resume arguments', async () => {
  assert.equal(await claimSessionAccount('codex', 'a', {}, { stateDir: dir, chained: true }), false);
  assert.throws(() => exactResumeArgs('codex', 'bad\nsession'));
});

test('model scopes preserve global limits while excluding unrelated model pools', () => {
  const now = Date.now();
  const entry = { status: 'quota_exhausted', fetchedAt: now, stale: false, windows: [
    { id: 'global', usedPercent: 10, fetchedAt: now },
    { id: 'opus', group: 'Opus', usedPercent: 100, fetchedAt: now - 120000 },
  ] };
  const sonnet = scopeUsage('claude', entry, 'claude-sonnet', { now });
  assert.equal(sonnet.status, 'ok'); assert.equal(sonnet.stale, false);
  assert.equal(scopeUsage('claude', entry, 'claude-opus', { now }).status, 'quota_exhausted');
  assert.equal(scopeUsage('claude', entry, undefined), entry);
  const agy = { ...entry, windows: [
    { id: 'g', group: 'Gemini Models', usedPercent: 100 },
    { id: 'c', group: 'Claude and GPT models', usedPercent: 5 },
  ] };
  assert.equal(scopeUsage('agy', agy, 'claude-sonnet', { now }).status, 'ok');
  assert.equal(scopeUsage('agy', agy, 'gemini-3', { now }).status, 'quota_exhausted');
  assert.equal(scopeUsage('codex', { ...entry, windows: [{ id: 'review', group: 'Code review', usedPercent: 100 },
    { id: 'global', usedPercent: 1 }] }, 'gpt-6-astra', { now }).status, 'ok');
  assert.equal(scopeUsage('agy', { ...agy, status: 'expired_login' }, 'claude', { now }).status, 'expired_login');
  const rolledWindow = scopeUsage('claude', { ...entry, status: 'ok', windows: [
    { id: 'global', usedPercent: 10, fetchedAt: now, resetAt: now - 1 },
  ] }, 'sonnet', { now });
  assert.equal(rolledWindow.stale, true, 'the model filter cannot restore a quota observation past its reset');
});
