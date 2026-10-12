import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  emptyAccounts, readAccounts, saveAccounts, hasAccounts, mutateAccounts,
  validateAccounts, validateCredentialReference, validMetadata, DEFAULT_POLICY,
} from '../src/accounts/config.js';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-account-config-'));
after(() => rmSync(DIR, { recursive: true, force: true }));
const fresh = name => join(DIR, name);
const credential = join(DIR, 'token');
writeFileSync(credential, 'fixture-token-never-used', { mode: 0o600 });
const configWithAccount = () => {
  const config = emptyAccounts();
  config.providers.claude.accounts.push({ id: 'work', name: 'Work account', credential: { type: 'claude-token', path: credential }, enabled: true, priority: 0 });
  return config;
};

test('missing config has all provider defaults and no enabled accounts', () => {
  const dir = fresh('missing');
  assert.deepEqual(readAccounts(dir), emptyAccounts());
  assert.equal(hasAccounts(undefined, dir), false);
  assert.equal(hasAccounts('not-a-provider', dir), false);
  const a = emptyAccounts(), b = emptyAccounts();
  a.providers.claude.policy.thresholdPercent = 1;
  assert.equal(b.providers.claude.policy.thresholdPercent, 95);
});

test('config round trip stores references and privately persists explicit policy', () => {
  const dir = fresh('valid');
  const config = configWithAccount();
  config.providers.claude.policy = { ...DEFAULT_POLICY, thresholdPercent: 90, strategy: 'priority', cooldownMs: 100, neverSwitch: true, onLimit: false };
  saveAccounts(config, dir);
  assert.deepEqual(readAccounts(dir), config);
  assert.equal(hasAccounts('claude', dir), true);
  assert.equal(hasAccounts('codex', dir), false);
  assert.equal(hasAccounts(undefined, dir), true);
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'accounts.json')).mode & 0o777, 0o600);
  assert.ok(!readFileSync(join(dir, 'accounts.json'), 'utf8').includes('fixture-token-never-used'));
});

test('corrupt config and unsupported schema do not silently become empty stores', async () => {
  const dir = fresh('corrupt');
  saveAccounts(emptyAccounts(), dir);
  const path = join(dir, 'accounts.json');
  for (const text of ['SUPRSECRET_invalid', 'null', '[]', '{"version":2,"providers":{}}', '{"version":1,"providers":{},"accessToken":"SUPRSECRET"}']) {
    writeFileSync(path, text, { mode: 0o600 });
    assert.throws(() => readAccounts(dir), e => !e.message.includes('SUPRSECRET'));
    await assert.rejects(mutateAccounts(c => { c.providers.claude.policy.neverSwitch = true; }, dir));
    assert.equal(readFileSync(path, 'utf8'), text);
  }
});

test('config rejects unknown fields, duplicate ids, invalid policies and unresolved selections', () => {
  const mutations = [
    c => { c.providers.claude.accounts.push({ ...c.providers.claude.accounts[0] }); },
    c => { c.providers.claude.accounts[0].refreshToken = 'SUPRSECRET'; },
    c => { c.providers.claude.accounts[0].credential.accessToken = 'SUPRSECRET'; },
    c => { c.providers.claude.accounts[0].credential.path = './relative'; },
    c => { c.providers.claude.accounts[0].credential.type = 'agy-token'; },
    c => { c.providers.claude.activeAccountId = 'missing'; },
    c => { c.providers.claude.pinnedAccountId = 'missing'; },
    c => { c.providers.claude.policy.thresholdPercent = 0; },
    c => { c.providers.claude.policy.thresholdPercent = 101; },
    c => { c.providers.claude.policy.cooldownMs = -1; },
    c => { c.providers.claude.policy.onLimit = 'false'; },
    c => { c.providers.claude.policy.strategy = 'arbitrary'; },
    c => { c.providers.claude.accounts[0].priority = Infinity; },
    c => { c.providers.claude.accounts[0].enabled = 'true'; },
  ];
  for (const mutate of mutations) {
    const config = configWithAccount();
    mutate(config);
    assert.throws(() => validateAccounts(config), { code: 'ACCOUNT_CONFIG_INVALID' });
  }
});

test('labels cannot carry terminal controls, obvious tokens, or opaque long data', () => {
  for (const value of ['\u001b[31mred', 'new\nline', 'sk-ant-private-value', 'ya29.private-token', 'eyJhbGciOiJIUzI1NiJ9.token.signature', 'x'.repeat(70), ' leading']) {
    assert.equal(validMetadata(value), false);
  }
  for (const value of ['Work account', 'Alice+test@example.com', 'Équipe', 'Personal (1)']) assert.equal(validMetadata(value), true);
});

test('private refs validate on registration; a disappeared credential remains manageable', async () => {
  const dir = fresh('missing-ref');
  const config = configWithAccount();
  const missing = join(DIR, 'nonexistent-token');
  config.providers.claude.accounts[0].credential.path = missing;
  assert.throws(() => validateCredentialReference(config.providers.claude.accounts[0].credential, 'claude'));
  saveAccounts(config, dir);
  assert.equal(readAccounts(dir).providers.claude.accounts[0].id, 'work');
  await mutateAccounts(c => { c.providers.claude.accounts[0].enabled = false; }, dir);
  assert.equal(hasAccounts('claude', dir), false);
  if (process.platform !== 'win32') {
    chmodSync(credential, 0o644);
    assert.throws(() => validateCredentialReference({ type: 'claude-token', path: credential }, 'claude'), { code: 'PRIVATE_FILE' });
    chmodSync(credential, 0o600);
  }
});

test('locked mutations preserve independent concurrent config changes', async () => {
  const dir = fresh('mutations');
  await Promise.all(Array.from({ length: 10 }, (_, index) => mutateAccounts(async c => {
    await new Promise(resolve => setTimeout(resolve, 2));
    c.providers.claude.accounts.push({ id: `account-${index}`, name: `Account ${index}`, credential: { type: 'claude-token', path: credential }, enabled: true, priority: index });
  }, dir)));
  assert.equal(readAccounts(dir).providers.claude.accounts.length, 10);
});
