import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { STATE_DIR } from '../config.js';
import {
  PROVIDERS, AccountConfigError, readAccounts, mutateAccounts,
  validMetadata, validatePolicy, validateCredentialReference,
} from './config.js';
import { PrivateStoreError, readPrivateJson, assertPrivateFile } from './store.js';

class AccountCommandError extends Error {}
const fail = message => { throw new AccountCommandError(message); };
const USAGE = `unsnooze accounts list [claude|codex|agy] [--json]
unsnooze accounts add <provider> <name> --path <private-file> [--record-id <id>] [--priority <number>]
unsnooze accounts import [claude|codex|agy|all] [--home <directory>] [--path <source>]
unsnooze accounts enable|disable|switch|pin <provider> <id-or-name>
unsnooze accounts unpin <provider>
unsnooze accounts rename <provider> <id-or-name> <new-name>
unsnooze accounts policy <provider> [<key> <value> | --threshold-percent <number> --on-limit <true|false> --strategy <headroom|priority|round-robin> --cooldown-ms <number> --never-switch <true|false>]`;

const OPTIONS = new Set(['home', 'path', 'state-dir', 'name', 'id', 'type', 'record-id', 'priority',
  'threshold-percent', 'on-limit', 'strategy', 'cooldown-ms', 'never-switch']);
const FLAGS = new Set(['json', 'disabled', 'help']);
const POLICY_OPTIONS = {
  'threshold-percent': 'thresholdPercent', 'on-limit': 'onLimit', strategy: 'strategy',
  'cooldown-ms': 'cooldownMs', 'never-switch': 'neverSwitch',
};

function parse(args) {
  const positionals = [], options = {};
  if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) fail('Invalid account command arguments.');
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    const eq = arg.indexOf('=');
    const key = arg.slice(2, eq < 0 ? undefined : eq);
    if (Object.hasOwn(options, key)) fail('Duplicate account command option.');
    if (FLAGS.has(key) && eq < 0) { options[key] = true; continue; }
    if (!OPTIONS.has(key)) fail('Unknown account command option.');
    const value = eq >= 0 ? arg.slice(eq + 1) : args[++i];
    if (typeof value !== 'string' || !value || value.startsWith('--')) fail('Account command option needs a value.');
    options[key] = value;
  }
  return { positionals, options };
}

function allowOptions(options, allowed) {
  if (Object.keys(options).some(key => !['state-dir', 'help', ...allowed].includes(key))) fail('Option is not supported for this account command.');
}

function providerName(value) {
  if (!PROVIDERS.includes(value)) fail('Provider must be claude, codex, or agy.');
  return value;
}

function accountByName(section, value) {
  if (!validMetadata(value, { id: true }) && !validMetadata(value)) fail('Invalid account identifier.');
  const exact = section.accounts.find(a => a.id === value);
  if (exact) return exact;
  const matches = section.accounts.filter(a => a.name === value);
  if (matches.length !== 1) fail('Account was not found or its name is ambiguous; use its id.');
  return matches[0];
}

function integer(value) {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) fail('Account option requires an integer.');
  return Number(value);
}

function boolean(value) {
  if (['true', 'on', 'yes'].includes(value)) return true;
  if (['false', 'off', 'no'].includes(value)) return false;
  fail('Account policy requires true or false.');
}

function sourcePath(value, home, base = home) {
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) fail('Invalid credential reference path.');
  return value === '~' ? home : value.startsWith('~/') ? resolve(home, value.slice(2)) : resolve(base, value);
}

const sameCredential = (a, b) => a.type === b.type && a.path === b.path && a.recordId === b.recordId;
function importedAccount(provider, name, credential) {
  if (!validMetadata(name)) fail('Imported account metadata is invalid.');
  validateCredentialReference(credential, provider);
  const id = `${provider}-${createHash('sha256').update(JSON.stringify(credential)).digest('hex').slice(0, 16)}`;
  return { id, name, credential, priority: 0, enabled: true };
}

function importSource(provider, home, explicitPath) {
  const defaults = {
    claude: join(home, '.local', 'opt', 'claude-rotate', 'config.json'),
    codex: join(home, '.codex', 'multi-auth', 'openai-codex-accounts.json'),
    agy: join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
  };
  const path = explicitPath ? sourcePath(explicitPath, home, process.cwd()) : defaults[provider];
  if (provider === 'agy') {
    try { assertPrivateFile(path); } catch (err) { if (err?.missing) return null; throw err; }
    return { accounts: [importedAccount(provider, 'Antigravity', { type: 'agy-token', path })], activeId: null };
  }
  const source = readPrivateJson(path, null);
  if (source === null) return null;
  if (!source || typeof source !== 'object' || !Array.isArray(source.accounts)) fail('Imported account configuration is invalid.');
  const seen = new Set();
  const accounts = source.accounts.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Imported account configuration is invalid.');
    let account;
    if (provider === 'claude') {
      account = importedAccount(provider, raw.name, { type: 'claude-token', path: sourcePath(raw.token_file, home, dirname(path)) });
    } else {
      if (!validMetadata(raw.recordId, { id: true })) fail('Imported account metadata is invalid.');
      const name = [raw.accountLabel, raw.email].find(value => validMetadata(value)) || `Codex account ${index + 1}`;
      account = importedAccount(provider, name, { type: 'codex-multi-auth', path, recordId: raw.recordId });
    }
    if (seen.has(account.id)) fail('Imported account configuration contains duplicate references.');
    seen.add(account.id);
    return account;
  });
  const activeIndex = provider === 'codex' ? source.activeIndex : undefined;
  if (activeIndex !== undefined && activeIndex !== null
      && (!Number.isInteger(activeIndex) || activeIndex < 0 || activeIndex >= accounts.length)) fail('Imported active account is invalid.');
  return { accounts, activeId: activeIndex == null ? null : accounts[activeIndex].id };
}

function listed(config, providers) {
  // Credential contents, source paths, and imported provider records never
  // leave the storage layer. Only validated user-facing metadata is listed.
  return Object.fromEntries(providers.map(provider => {
    const section = config.providers[provider];
    return [provider, {
      accounts: section.accounts.map(({ id, name, enabled, priority }) => ({ id, name, enabled, priority })),
      activeAccountId: section.activeAccountId, pinnedAccountId: section.pinnedAccountId, policy: section.policy,
    }];
  }));
}

export async function cmdAccounts(args = []) {
  try {
    const { positionals, options } = parse(args);
    const [action = 'list', providerArg, accountArg, ...extra] = positionals;
    const stateDir = options['state-dir'] ? resolve(options['state-dir']) : STATE_DIR;
    if (options.help || action === 'help') { console.log(USAGE); return 0; }
    if (action === 'list') {
      allowOptions(options, ['json']);
      if (accountArg !== undefined || extra.length) fail('Too many account command arguments.');
      const providers = providerArg === undefined ? PROVIDERS : [providerName(providerArg)];
      const view = listed(readAccounts(stateDir), providers);
      if (options.json) console.log(JSON.stringify({ version: 1, providers: view }, null, 2));
      else {
        for (const provider of providers) {
          const section = view[provider];
          console.log(`${provider}:`);
          if (!section.accounts.length) console.log('  No accounts configured.');
          for (const a of section.accounts) {
            const flags = [a.enabled ? 'enabled' : 'disabled', a.id === section.activeAccountId ? 'active' : '', a.id === section.pinnedAccountId ? 'pinned' : ''].filter(Boolean).join(', ');
            console.log(`  ${a.id}  ${a.name}  priority=${a.priority}  ${flags}`);
          }
        }
      }
      return 0;
    }
    if (action === 'import') {
      allowOptions(options, ['home', 'path']);
      if (accountArg !== undefined || extra.length) fail('Too many account command arguments.');
      const providers = !providerArg || providerArg === 'all' ? PROVIDERS : [providerName(providerArg)];
      if (options.path && providers.length > 1) fail('An explicit import path requires one provider.');
      const home = options.home ? resolve(options.home) : homedir();
      // Validate every source before changing the config. A malformed source
      // cannot leave a partially imported set of providers.
      const sources = providers.map(provider => ({ provider, source: importSource(provider, home, options.path) }));
      if (providers.length === 1 && sources[0].source === null) fail('Account import source was not found.');
      let count = 0;
      await mutateAccounts(config => {
        for (const { provider, source } of sources) {
          if (!source) continue;
          const section = config.providers[provider];
          for (const a of source.accounts) {
            if (section.accounts.some(existing => sameCredential(existing.credential, a.credential))) continue;
            section.accounts.push(a);
            count++;
          }
          if (section.activeAccountId === null && source.activeId !== null) {
            const importedActive = source.accounts.find(a => a.id === source.activeId);
            const active = section.accounts.find(a => sameCredential(a.credential, importedActive.credential));
            if (active?.enabled) section.activeAccountId = active.id;
          }
        }
      }, stateDir);
      console.log(`Imported ${count} account reference${count === 1 ? '' : 's'}.`);
      return 0;
    }
    const provider = providerName(providerArg);
    if (action === 'add') {
      allowOptions(options, ['name', 'path', 'id', 'type', 'record-id', 'priority', 'disabled']);
      if (extra.length || (accountArg !== undefined && options.name)) fail('Too many account command arguments.');
      const name = options.name || accountArg;
      if (!validMetadata(name) || !options.path) fail('Adding an account requires a name and a private credential path.');
      const id = options.id || `${provider}-${randomUUID()}`;
      if (!validMetadata(id, { id: true })) fail('Invalid account identifier.');
      const credential = validateCredentialReference({
        type: options.type || { claude: 'claude-token', codex: 'codex-multi-auth', agy: 'agy-token' }[provider],
        path: sourcePath(options.path, homedir(), process.cwd()),
        ...(options['record-id'] ? { recordId: options['record-id'] } : {}),
      }, provider);
      const account = { id, name, credential, priority: options.priority === undefined ? 0 : integer(options.priority), enabled: !options.disabled };
      await mutateAccounts(config => {
        const section = config.providers[provider];
        if (section.accounts.some(a => a.id === id || sameCredential(a.credential, credential))) fail('Account identifier or credential reference is already configured.');
        section.accounts.push(account);
      }, stateDir);
      console.log('Account reference added.');
      return 0;
    }
    if (action === 'policy') {
      allowOptions(options, Object.keys(POLICY_OPTIONS));
      const policyArgs = positionals.slice(2);
      const updates = Object.create(null);
      for (let i = 0; i < policyArgs.length; i++) {
        const item = policyArgs[i];
        const eq = item.indexOf('=');
        const key = eq < 0 ? item : item.slice(0, eq);
        const value = eq < 0 ? policyArgs[++i] : item.slice(eq + 1);
        if (value === undefined || Object.hasOwn(updates, key)) fail('Invalid account policy arguments.');
        updates[key] = value;
      }
      for (const [flag, key] of Object.entries(POLICY_OPTIONS)) {
        if (options[flag] !== undefined) {
          if (Object.hasOwn(updates, key)) fail('Duplicate account policy option.');
          updates[key] = options[flag];
        }
      }
      const parsed = {};
      for (const [key, value] of Object.entries(updates)) {
        if (!Object.values(POLICY_OPTIONS).includes(key)) fail('Unknown account policy setting.');
        parsed[key] = ['onLimit', 'neverSwitch'].includes(key) ? boolean(value)
          : key === 'cooldownMs' ? integer(value)
          : key === 'thresholdPercent' ? (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) ? Number(value) : NaN)
          : value;
      }
      const config = Object.keys(parsed).length ? await mutateAccounts(config => {
        config.providers[provider].policy = validatePolicy({ ...config.providers[provider].policy, ...parsed });
      }, stateDir) : readAccounts(stateDir);
      console.log(JSON.stringify(config.providers[provider].policy, null, 2));
      return 0;
    }
    if (action === 'rename') {
      allowOptions(options, []);
      if (!accountArg || extra.length !== 1 || !validMetadata(extra[0])) fail('Renaming an account requires its id and a valid display name.');
      await mutateAccounts(config => {
        accountByName(config.providers[provider], accountArg).name = extra[0];
      }, stateDir);
      console.log('Account name updated.');
      return 0;
    }
    if (['enable', 'disable', 'switch', 'pin', 'unpin'].includes(action)) {
      allowOptions(options, []);
      if (extra.length || (action === 'unpin' ? accountArg !== undefined : accountArg === undefined)) fail('Invalid account command arguments.');
      await mutateAccounts(config => {
        const section = config.providers[provider];
        if (action === 'unpin') { section.pinnedAccountId = null; return; }
        const account = accountByName(section, accountArg);
        if (action === 'enable' || action === 'disable') {
          account.enabled = action === 'enable';
          if (!account.enabled) {
            if (section.activeAccountId === account.id) section.activeAccountId = null;
            if (section.pinnedAccountId === account.id) section.pinnedAccountId = null;
          }
        } else {
          if (!account.enabled) fail('Enable the account before selecting it.');
          if (action === 'switch' && section.pinnedAccountId && section.pinnedAccountId !== account.id) fail('Unpin the current account before switching.');
          section.activeAccountId = account.id;
          if (action === 'pin') section.pinnedAccountId = account.id;
        }
      }, stateDir);
      console.log('Account configuration updated.');
      return 0;
    }
    fail('Unknown account command. Use accounts help.');
  } catch (err) {
    // Never forward JSON/OS errors, raw source records, paths, tokens, or
    // unchecked option values to terminal output.
    console.error(err instanceof AccountCommandError || err instanceof AccountConfigError || err instanceof PrivateStoreError
      ? err.message : 'Account command failed.');
    return 1;
  }
}
