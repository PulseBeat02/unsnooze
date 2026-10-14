import { join, isAbsolute } from 'node:path';
import { STATE_DIR } from '../config.js';
import { readPrivateJson, atomicPrivateJson, assertPrivateFile, withStoreLock } from './store.js';

export const PROVIDERS = Object.freeze(['claude', 'codex', 'agy']);
export const DEFAULT_POLICY = Object.freeze({
  thresholdPercent: 95, onLimit: true, strategy: 'headroom', cooldownMs: 60_000, neverSwitch: false,
});
export const ACCOUNT_USAGE_MAX_AGE_MS = 60_000;
// "remote" marks an account whose login is held by the account host (see
// src/accounts/remote.js); its path is the host socket, never a credential.
const CREDENTIAL_TYPES = { claude: ['claude-token', 'managed', 'remote'], codex: ['codex-multi-auth', 'managed', 'remote'], agy: ['agy-token'] };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (v, keys) => object(v) && Object.keys(v).every(k => keys.includes(k));

export class AccountConfigError extends Error {
  constructor() {
    super('Account configuration is invalid; check its schema and private credential references.');
    this.name = 'AccountConfigError';
    this.code = 'ACCOUNT_CONFIG_INVALID';
  }
}

export function emptyAccounts() {
  return { version: 1, providers: Object.fromEntries(PROVIDERS.map(provider => [provider, {
    accounts: [], policy: { ...DEFAULT_POLICY }, activeAccountId: null, pinnedAccountId: null,
  }])) };
}

// Names are display metadata, not arbitrary imported text. Reject controls,
// token-shaped strings and long opaque runs before they can reach a terminal.
export function validMetadata(value, { id = false } = {}) {
  return typeof value === 'string' && value.length > 0 && value.length <= (id ? 128 : 120)
    && value === value.trim() && (id ? /^[A-Za-z0-9][A-Za-z0-9_.:@+-]*$/ : /^[\p{L}\p{N}][\p{L}\p{N} ._@+():\[\]'-]*$/u).test(value)
    && !/(?:^|\s)(?:sk-|ya29\.|eyJ)[A-Za-z0-9_.-]+/i.test(value)
    && !/[A-Za-z0-9_-]{65,}/.test(value);
}

export function validatePolicy(policy) {
  if (!onlyKeys(policy, Object.keys(DEFAULT_POLICY))) throw new AccountConfigError();
  const out = { ...DEFAULT_POLICY, ...policy };
  if (!Number.isFinite(out.thresholdPercent) || out.thresholdPercent <= 0 || out.thresholdPercent > 100
      || typeof out.onLimit !== 'boolean' || typeof out.neverSwitch !== 'boolean'
      || !['headroom', 'priority', 'round-robin'].includes(out.strategy)
      || !Number.isSafeInteger(out.cooldownMs) || out.cooldownMs < 0 || out.cooldownMs > 86_400_000) throw new AccountConfigError();
  return out;
}

export function validateCredentialReference(credential, provider, { checkFile = true } = {}) {
  if (!onlyKeys(credential, ['type', 'path', 'recordId']) || !CREDENTIAL_TYPES[provider]?.includes(credential.type)
      || typeof credential.path !== 'string' || !isAbsolute(credential.path) || /[\0\r\n]/.test(credential.path)
      || (credential.type === 'codex-multi-auth' && !validMetadata(credential.recordId, { id: true }))
      || (credential.recordId !== undefined && credential.type !== 'codex-multi-auth')) throw new AccountConfigError();
  if (checkFile && credential.type !== 'remote') assertPrivateFile(credential.path);
  return { type: credential.type, path: credential.path,
    ...(credential.recordId === undefined ? {} : { recordId: credential.recordId }) };
}

export function validateAccounts(config, { checkFiles = false } = {}) {
  if (!onlyKeys(config, ['version', 'providers']) || config.version !== 1
      || !onlyKeys(config.providers, PROVIDERS)) throw new AccountConfigError();
  const result = emptyAccounts();
  for (const provider of PROVIDERS) {
    const section = config.providers[provider];
    if (section === undefined) continue;
    if (!onlyKeys(section, ['accounts', 'policy', 'activeAccountId', 'pinnedAccountId']) || !Array.isArray(section.accounts)) throw new AccountConfigError();
    const ids = new Set();
    const accounts = section.accounts.map(a => {
      if (!onlyKeys(a, ['id', 'name', 'credential', 'priority', 'enabled'])
          || !validMetadata(a.id, { id: true }) || !validMetadata(a.name) || ids.has(a.id)
          || !Number.isSafeInteger(a.priority) || Math.abs(a.priority) > 1_000_000 || typeof a.enabled !== 'boolean') throw new AccountConfigError();
      ids.add(a.id);
      return { id: a.id, name: a.name, credential: validateCredentialReference(a.credential, provider, { checkFile: checkFiles }), priority: a.priority, enabled: a.enabled };
    });
    for (const key of ['activeAccountId', 'pinnedAccountId']) {
      if (section[key] !== null && section[key] !== undefined && !ids.has(section[key])) throw new AccountConfigError();
    }
    result.providers[provider] = { accounts, policy: validatePolicy(section.policy ?? {}),
      activeAccountId: section.activeAccountId ?? null, pinnedAccountId: section.pinnedAccountId ?? null };
  }
  return result;
}

export function readAccounts(stateDir = STATE_DIR) {
  return validateAccounts(readPrivateJson(join(stateDir, 'accounts.json'), emptyAccounts()));
}

// This writes a complete snapshot; callers doing read/modify/write must use
// mutateAccounts or withStoreLock on this same accounts.json path.
export function saveAccounts(config, stateDir = STATE_DIR) {
  const validated = validateAccounts(config);
  atomicPrivateJson(join(stateDir, 'accounts.json'), validated);
  return validated;
}

export function hasAccounts(provider, stateDir = STATE_DIR) {
  if (provider !== undefined && !PROVIDERS.includes(provider)) return false;
  const config = readAccounts(stateDir);
  return (provider === undefined ? PROVIDERS : [provider]).some(p => config.providers[p].accounts.some(a => a.enabled));
}

export async function mutateAccounts(fn, stateDir = STATE_DIR) {
  return withStoreLock(join(stateDir, 'accounts.json'), async () => {
    const config = readAccounts(stateDir);
    const updated = await fn(config);
    return saveAccounts(updated ?? config, stateDir);
  });
}
