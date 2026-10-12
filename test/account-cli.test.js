import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { readAccounts, saveAccounts, emptyAccounts } from '../src/accounts/config.js';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-account-cli-'));
const MODULE = new URL('../src/accounts/cli.js', import.meta.url).href;
after(() => rmSync(DIR, { recursive: true, force: true }));
const script = `import {cmdAccounts} from ${JSON.stringify(MODULE)};process.exitCode=await cmdAccounts(process.argv.slice(1));`;
const privateFile = (path, value) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  return path;
};
function run(dir, ...args) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, '--', ...args, '--state-dir', dir], { encoding: 'utf8', env: { ...process.env, UNSNOOZE_STATE_DIR: dir }, timeout: 10_000 });
  assert.equal(result.error, undefined);
  return { code: result.status, output: result.stdout, error: result.stderr };
}

test('add/list/disable/enable/switch/pin/unpin and configurable policy work across fresh processes', () => {
  const dir = join(DIR, 'commands');
  const token = privateFile(join(DIR, 'claude-token'), 'SUPRSECRET_fixture_token');
  assert.equal(run(dir, 'add', 'claude', 'Personal', '--id', 'personal', '--path', token).code, 0);
  const token2 = privateFile(join(DIR, 'work-token'), 'SUPRSECRET_second_token');
  assert.equal(run(dir, 'add', 'claude', '--name', 'Work', '--id', 'work', '--path', token2, '--priority', '9', '--disabled').code, 0);
  assert.equal(run(dir, 'switch', 'claude', 'work').code, 1);
  assert.equal(run(dir, 'enable', 'claude', 'work').code, 0);
  assert.equal(run(dir, 'switch', 'claude', 'Work').code, 0);
  assert.equal(readAccounts(dir).providers.claude.activeAccountId, 'work');
  assert.equal(run(dir, 'rename', 'claude', 'work', 'Account2').code, 0);
  assert.equal(readAccounts(dir).providers.claude.accounts[1].name, 'Account2');
  assert.equal(run(dir, 'pin', 'claude', 'work').code, 0);
  assert.equal(run(dir, 'switch', 'claude', 'personal').code, 1);
  assert.equal(run(dir, 'unpin', 'claude').code, 0);
  assert.equal(run(dir, 'pin', 'claude', 'personal').code, 0);
  assert.equal(run(dir, 'disable', 'claude', 'personal').code, 0);
  let section = readAccounts(dir).providers.claude;
  assert.equal(section.activeAccountId, null);
  assert.equal(section.pinnedAccountId, null);
  assert.equal(run(dir, 'policy', 'claude', '--threshold-percent', '88.5', '--on-limit', 'off', '--strategy', 'priority', '--cooldown-ms', '250', '--never-switch', 'true').code, 0);
  section = readAccounts(dir).providers.claude;
  assert.deepEqual(section.policy, { thresholdPercent: 88.5, onLimit: false, strategy: 'priority', cooldownMs: 250, neverSwitch: true });
  assert.equal(run(dir, 'policy', 'claude', 'onLimit', 'true', 'neverSwitch=false').code, 0);
  assert.equal(readAccounts(dir).providers.claude.policy.neverSwitch, false);
  const listing = run(dir, 'list', '--json');
  assert.equal(listing.code, 0);
  const accounts = JSON.parse(listing.output).providers.claude.accounts;
  assert.equal(accounts.length, 2);
  assert.ok(!listing.output.includes('SUPRSECRET'));
  assert.ok(!listing.output.includes(token));
  assert.ok(!listing.output.includes('credential'));
});

test('import all providers preserves source bytes and writes references without credential material', () => {
  const home = join(DIR, 'import-home'), dir = join(DIR, 'import-state');
  const claudeConfig = join(home, '.local', 'opt', 'claude-rotate', 'config.json');
  const claudeToken = privateFile(join(dirname(claudeConfig), 'tokens', 'work'), 'SUPRSECRET_claude');
  privateFile(claudeConfig, { accounts: [{ name: 'Work Claude', token_file: 'tokens/work' }], settings: { ignored: true } });
  const codexPath = privateFile(join(home, '.codex', 'multi-auth', 'openai-codex-accounts.json'), {
    activeIndex: 1, accounts: [
      { recordId: 'record-a', accountLabel: 'Personal (role:owner) [id:c2Z8tL]', email: 'work@example.com', accessToken: 'SUPRSECRET_codex_a', refreshToken: 'SUPRSECRET_refresh_a', workspaces: [{ id: 'workspace-a' }], currentWorkspaceIndex: 0 },
      { recordId: 'record-b', accountLabel: 'unsafe\nlabel', email: 'personal@example.com', accessToken: 'SUPRSECRET_codex_b', refreshToken: 'SUPRSECRET_refresh_b' },
    ],
  });
  const agyPath = privateFile(join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), {
    token: { access_token: 'SUPRSECRET_agy', refresh_token: 'SUPRSECRET_agy_refresh', token_type: 'Bearer', expiry: '2099-01-01T00:00:00Z' }, auth_method: 'oauth', id_token: 'SUPRSECRET_id',
  });
  const paths = [claudeConfig, claudeToken, codexPath, agyPath];
  const before = paths.map(path => readFileSync(path, 'utf8'));
  const imported = run(dir, 'import', 'all', '--home', home);
  assert.equal(imported.code, 0, imported.error);
  assert.match(imported.output, /Imported 4 account references/);
  const config = readAccounts(dir);
  assert.deepEqual(config.providers.claude.accounts[0].credential, { type: 'claude-token', path: claudeToken });
  assert.equal(config.providers.codex.accounts.length, 2);
  assert.equal(config.providers.codex.accounts[0].credential.recordId, 'record-a');
  assert.equal(config.providers.codex.accounts[0].name, 'Personal (role:owner) [id:c2Z8tL]');
  assert.equal(config.providers.codex.accounts[1].name, 'personal@example.com');
  assert.equal(config.providers.codex.activeAccountId, config.providers.codex.accounts[1].id);
  assert.equal(config.providers.agy.accounts[0].credential.path, agyPath);
  for (let i = 0; i < paths.length; i++) assert.equal(readFileSync(paths[i], 'utf8'), before[i]);
  assert.ok(!readFileSync(join(dir, 'accounts.json'), 'utf8').includes('SUPRSECRET'));
  assert.ok(!imported.output.includes('SUPRSECRET'));
  assert.ok(!imported.error.includes('SUPRSECRET'));
  assert.match(run(dir, 'import', 'all', '--home', home).output, /Imported 0 account references/);
  assert.equal(readAccounts(dir).providers.codex.accounts.length, 2);
});

test('import is all-or-nothing when another provider source is corrupt', () => {
  const home = join(DIR, 'bad-home'), dir = join(DIR, 'bad-import-state');
  const cfg = join(home, '.local', 'opt', 'claude-rotate', 'config.json');
  privateFile(join(dirname(cfg), 'token'), 'SUPRSECRET_claude');
  privateFile(cfg, { accounts: [{ name: 'Valid', token_file: 'token' }] });
  const codex = privateFile(join(home, '.codex', 'multi-auth', 'openai-codex-accounts.json'), 'SUPRSECRET_invalid_json');
  saveAccounts(emptyAccounts(), dir);
  const before = readFileSync(join(dir, 'accounts.json'), 'utf8');
  const output = run(dir, 'import', 'all', '--home', home);
  assert.equal(output.code, 1);
  assert.ok(!output.error.includes('SUPRSECRET'));
  assert.ok(!output.error.includes('Unexpected token'));
  assert.equal(readFileSync(join(dir, 'accounts.json'), 'utf8'), before);
  assert.equal(readFileSync(codex, 'utf8'), 'SUPRSECRET_invalid_json');
});

test('explicit import path and tilde credential path are resolved within fixture home', () => {
  const home = join(DIR, 'explicit-home'), dir = join(DIR, 'explicit-state');
  const token = privateFile(join(home, 'tokens', 'custom'), 'SUPRSECRET_reference');
  const config = privateFile(join(home, 'elsewhere.json'), { accounts: [{ name: 'Custom', token_file: '~/tokens/custom' }] });
  const result = run(dir, 'import', 'claude', '--home', home, '--path', config);
  assert.equal(result.code, 0, result.error);
  assert.equal(readAccounts(dir).providers.claude.accounts[0].credential.path, token);
});

test('CLI refuses private-file violations, duplicate references, unsafe metadata, and policy errors', () => {
  const dir = join(DIR, 'validation');
  const token = privateFile(join(DIR, 'validation-token'), 'SUPRSECRET_validation');
  assert.equal(run(dir, 'add', 'claude', 'Valid', '--path', token, '--id', 'valid').code, 0);
  for (const args of [
    ['add', 'claude', 'Duplicate', '--path', token],
    ['add', 'claude', 'sk-ant-SUPRSECRET', '--path', token],
    ['add', 'claude', 'bad\nname', '--path', token],
    ['add', 'codex', 'Missing record', '--path', token],
    ['list', '--unknown', 'SUPRSECRET'],
    ['policy', 'claude', 'thresholdPercent', '101'],
    ['policy', 'claude', '--on-limit', 'maybe-SUPRSECRET'],
    ['policy', 'claude', 'cooldownMs', '-1'],
    ['policy', 'claude', 'strategy', 'SUPRSECRET'],
  ]) {
    const output = run(dir, ...args);
    assert.equal(output.code, 1, JSON.stringify(args));
    assert.ok(!output.error.includes('SUPRSECRET'));
  }
  if (process.platform !== 'win32') {
    const exposed = privateFile(join(DIR, 'exposed-token'), 'SUPRSECRET_exposed');
    chmodSync(exposed, 0o644);
    assert.equal(run(dir, 'add', 'claude', 'Exposed', '--path', exposed).code, 1);
    const link = join(DIR, 'linked-token');
    symlinkSync(token, link);
    assert.equal(run(dir, 'add', 'claude', 'Linked', '--path', link).code, 1);
  }
});

test('corrupt account config commands do not print secrets or overwrite state', () => {
  const dir = join(DIR, 'corrupt-state');
  const path = privateFile(join(dir, 'accounts.json'), 'SUPRSECRET_invalid');
  for (const args of [['list'], ['policy', 'claude', 'neverSwitch', 'true'], ['unpin', 'claude']]) {
    const result = run(dir, ...args);
    assert.equal(result.code, 1);
    assert.ok(!result.output.includes('SUPRSECRET'));
    assert.ok(!result.error.includes('SUPRSECRET'));
    assert.equal(readFileSync(path, 'utf8'), 'SUPRSECRET_invalid');
  }
});
