import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCredential, CredentialError } from '../src/accounts/credentials.js';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-credentials-'));
after(() => rmSync(DIR, { recursive: true, force: true }));
let serial = 0;
function fixture(type, body, extra = {}) {
  const path = join(DIR, `credential-${serial++}`);
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body), { mode: 0o600 });
  return { id: 'fixture', credential: { type, path, ...extra } };
}

test('plain Claude reference is trimmed, read-only, and never copied into errors', () => {
  const account = fixture('claude-token', 'fixture-claude-token\n');
  const before = statSync(account.credential.path);
  assert.deepEqual(readCredential(account), { accessToken: 'fixture-claude-token' });
  assert.equal(readFileSync(account.credential.path, 'utf8'), 'fixture-claude-token\n');
  assert.equal(statSync(account.credential.path).mtimeMs, before.mtimeMs);
  assert.equal(statSync(account.credential.path).mode, before.mode);
  assert.throws(() => readCredential(fixture('claude-token', 'Bearer secret-token')), CredentialError);
});

test('Codex record selector targets selected workspace and cannot fall back to another login', () => {
  const account = fixture('codex-multi-auth', { activeIndex: 0, accounts: [
    { recordId: 'one', accountId: 'first', accessToken: 'first-token' },
    { recordId: 'two', accountId: 'personal', accessToken: 'second-token', refreshToken: 'refresh-fixture',
      expiresAt: 1899999999000, workspaces: [{ id: 'personal' }, { id: 'team', enabled: true }], currentWorkspaceIndex: 1 },
  ] }, { recordId: 'two' });
  assert.deepEqual(readCredential(account), { accessToken: 'second-token', refreshToken: 'refresh-fixture',
    expiresAt: 1899999999000, accountId: 'team' });
  account.credential.recordId = 'absent';
  assert.throws(() => readCredential(account), CredentialError);
  delete account.credential.recordId;
  assert.throws(() => readCredential(account), CredentialError);
});

test('Codex duplicate selectors and invalid workspace selections fail closed', () => {
  for (const accounts of [
    [{ recordId: 'same', accessToken: 'a' }, { recordId: 'same', accessToken: 'b' }],
    [{ recordId: 'same', accessToken: 'a', currentWorkspaceIndex: 2, workspaces: [{ id: 'one' }] }],
  ]) assert.throws(() => readCredential(fixture('codex-multi-auth', { accounts }, { recordId: 'same' })), CredentialError);
});

test('Antigravity native token schema preserves expiry without refreshing or rewriting', () => {
  const account = fixture('agy-token', { token: { access_token: 'agy-token', refresh_token: 'agy-refresh',
    expiry: '2026-10-13T12:00:00Z' }, id_token: 'fixture-id-token' });
  assert.deepEqual(readCredential(account), { accessToken: 'agy-token', refreshToken: 'agy-refresh',
    expiresAt: Date.parse('2026-10-13T12:00:00Z'), idToken: 'fixture-id-token' });
});

test('managed credentials and JWT expiration normalize without trusting identity claims', () => {
  const jwt = `e30.${Buffer.from(JSON.stringify({ exp: 1900000000, email: 'ignored' })).toString('base64url')}.signature`;
  assert.deepEqual(readCredential(fixture('managed', { access_token: jwt, account_id: 'acct',
    secret: 'never-returned' })), { accessToken: jwt, expiresAt: 1900000000000, accountId: 'acct' });
  assert.deepEqual(readCredential(fixture('managed', { accessToken: 'a', expiresAt: 1900000000 })),
    { accessToken: 'a', expiresAt: 1900000000000 });
});

test('missing, malformed, insecure, and symlink credential errors expose no path or contents', () => {
  const bad = fixture('managed', '{private-secret-invalid-json');
  for (const account of [bad, fixture('managed', []), fixture('agy-token', { token: {} }),
    fixture('managed', { accessToken: 'secret', expiresAt: 'nonsense' }),
    { credential: { type: 'managed', path: join(DIR, 'missing-secret-path') } }]) {
    assert.throws(() => readCredential(account), err => err instanceof CredentialError
      && !/private-secret|secret-path|ENOENT|SyntaxError/.test(err.message));
  }
  if (process.platform !== 'win32') {
    const account = fixture('claude-token', 'private-secret');
    chmodSync(account.credential.path, 0o644);
    assert.throws(() => readCredential(account), CredentialError);
    const linked = join(DIR, 'linked');
    symlinkSync(bad.credential.path, linked);
    assert.throws(() => readCredential({ credential: { type: 'managed', path: linked } }), CredentialError);
  }
});
