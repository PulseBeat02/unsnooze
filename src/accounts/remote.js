// Remote account mode: another unsnooze (the host router) owns the provider
// logins. This side keeps its local router port and token for its own clients,
// forwards routed requests over a Unix socket and asks the host for usage and
// account selection. It never reads, refreshes or stores a provider credential.
import http from 'node:http';
import { isAbsolute, join } from 'node:path';
import { STATE_DIR } from '../config.js';
import { readPrivateJson, atomicPrivateJson, withStoreLock } from './store.js';

export const REMOTE_FILE = 'accounts-remote.json';
export const REMOTE_PROVIDERS = Object.freeze(['claude', 'codex']);
const SAVED_FILE = 'accounts.pre-remote.json';
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export class RemoteUnavailable extends Error {
  constructor(message = 'Account host is unavailable.') {
    super(message);
    this.name = 'RemoteUnavailable';
    this.code = 'remote_unavailable';
  }
}

export function validateRemoteConfig(value) {
  if (!object(value) || value.version !== 1 || typeof value.socket !== 'string'
    || !isAbsolute(value.socket) || /[\0\r\n]/.test(value.socket) || value.socket.length > 100
    || !Array.isArray(value.providers) || !value.providers.length
    || value.providers.some(p => !REMOTE_PROVIDERS.includes(p))
    || new Set(value.providers).size !== value.providers.length
    || Object.keys(value).some(k => !['version', 'socket', 'providers'].includes(k))) {
    throw new Error('Remote account configuration is invalid.');
  }
  return { version: 1, socket: value.socket, providers: [...value.providers] };
}

// Read on every call: removing the file switches routing back to local
// credentials without restarting the daemon or any session.
export function readRemoteConfig(stateDir = STATE_DIR) {
  const raw = readPrivateJson(join(stateDir, REMOTE_FILE), null);
  return raw === null ? null : validateRemoteConfig(raw);
}

export function remoteProvider(provider, stateDir = STATE_DIR, readFn = readRemoteConfig) {
  const remote = readFn(stateDir);
  return remote?.providers.includes(provider) ? remote : null;
}

// One HTTP request over the host socket. The caller owns the response stream.
export function remoteRequest(remote, { method = 'GET', path, headers = {}, body, signal, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: remote.socket, method, path,
      headers: { ...headers, host: 'unsnooze-host', ...(body ? { 'content-length': String(body.length) } : {}) } });
    const timer = timeoutMs ? setTimeout(() => req.destroy(new RemoteUnavailable('Account host timed out.')), timeoutMs) : null;
    const abort = () => req.destroy(new RemoteUnavailable('Request aborted.'));
    signal?.addEventListener('abort', abort, { once: true });
    req.on('response', res => { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(res); });
    req.on('error', () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new RemoteUnavailable());
    });
    req.end(body);
  });
}

export async function remoteJson(remote, method, path, payload, { timeoutMs = 30_000, requestFn = remoteRequest } = {}) {
  const body = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload));
  const res = await requestFn(remote, { method, path, timeoutMs, body,
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) } });
  let size = 0;
  const chunks = [];
  for await (const chunk of res) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) { res.destroy(); throw new RemoteUnavailable('Account host reply is too large.'); }
    chunks.push(chunk);
  }
  if (res.statusCode !== 200) throw new RemoteUnavailable(`Account host replied ${res.statusCode}.`);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RemoteUnavailable('Account host reply is not JSON.'); }
}

export function remoteUsage(remote, { refresh = false, allowProbe = false, jsonFn = remoteJson } = {}) {
  const query = new URLSearchParams({ ...(refresh ? { refresh: '1' } : {}), ...(allowProbe ? { probe: '1' } : {}) });
  return jsonFn(remote, 'GET', `/accounts/v1/usage${query.size ? `?${query}` : ''}`);
}

export async function remoteSelect(remote, provider, {
  reason = 'request', exclude = [], refresh = false, minFetchedAt = 0, model, jsonFn = remoteJson,
} = {}) {
  const reply = await jsonFn(remote, 'POST', '/accounts/v1/select', {
    provider, reason, exclude, refresh, minFetchedAt, ...(typeof model === 'string' ? { model } : {}),
  });
  if (!object(reply)) throw new RemoteUnavailable('Account host reply is invalid.');
  return reply;
}

// Public account metadata only: never credential references, paths or tokens.
export function publicAccounts(config, providers = Object.keys(config.providers)) {
  return { version: 1, providers: Object.fromEntries(providers.map(provider => {
    const section = config.providers[provider];
    return [provider, {
      accounts: section.accounts.map(({ id, name, enabled, priority }) => ({ id, name, enabled, priority })),
      activeAccountId: section.activeAccountId, pinnedAccountId: section.pinnedAccountId, policy: section.policy,
    }];
  })) };
}

// Mirror the host's account metadata so local readers (daemon start, gate,
// reconciliation, `accounts list`) see the same ids and policy. The mirrored
// references are of type "remote": nothing local can read a credential.
export async function syncRemoteAccounts(stateDir = STATE_DIR, {
  remote = readRemoteConfig(stateDir), jsonFn = remoteJson,
} = {}) {
  if (!remote) return false;
  const view = await jsonFn(remote, 'GET', '/accounts/v1/accounts');
  const { mutateAccounts } = await import('./config.js');
  let changed = false;
  await mutateAccounts(config => {
    for (const provider of remote.providers) {
      const source = view?.providers?.[provider];
      if (!object(source) || !Array.isArray(source.accounts)) throw new RemoteUnavailable('Account host reply is invalid.');
      const next = {
        // Same key order as validateAccounts, so an unchanged mirror compares equal.
        accounts: source.accounts.map(a => ({ id: a.id, name: a.name,
          credential: { type: 'remote', path: remote.socket }, priority: a.priority, enabled: a.enabled })),
        policy: source.policy, activeAccountId: source.activeAccountId ?? null,
        pinnedAccountId: source.pinnedAccountId ?? null,
      };
      if (JSON.stringify(next) !== JSON.stringify(config.providers[provider])) {
        config.providers[provider] = next;
        changed = true;
      }
    }
  }, stateDir);
  return changed;
}

export async function enableRemote(stateDir = STATE_DIR, { socket, providers = [...REMOTE_PROVIDERS], jsonFn = remoteJson } = {}) {
  const remote = validateRemoteConfig({ version: 1, socket, providers });
  const health = await jsonFn(remote, 'GET', '/health');
  if (health?.ok !== true || health.service !== 'unsnooze-accounts-host') {
    throw new RemoteUnavailable('The socket is not an unsnooze account host.');
  }
  const { readAccounts } = await import('./config.js');
  await withStoreLock(join(stateDir, REMOTE_FILE), async () => {
    // Keep the local references once, so `remote disable` can restore them.
    const current = readPrivateJson(join(stateDir, SAVED_FILE), null);
    const local = readAccounts(stateDir);
    const alreadyRemote = Object.values(local.providers).some(s => s.accounts.some(a => a.credential.type === 'remote'));
    if (!current && !alreadyRemote) atomicPrivateJson(join(stateDir, SAVED_FILE), local);
  });
  // Switch first: from here every routed request, usage read and selection
  // goes to the host even while the local mirror is still being written.
  atomicPrivateJson(join(stateDir, REMOTE_FILE), remote);
  await syncRemoteAccounts(stateDir, { remote, jsonFn });
  return remote;
}

export async function disableRemote(stateDir = STATE_DIR) {
  const remote = readRemoteConfig(stateDir);
  const saved = readPrivateJson(join(stateDir, SAVED_FILE), null);
  const { mutateAccounts, validateAccounts } = await import('./config.js');
  const restoredFrom = saved ? validateAccounts(saved) : null;
  await mutateAccounts(config => {
    for (const provider of remote?.providers ?? REMOTE_PROVIDERS) {
      if (restoredFrom) config.providers[provider] = restoredFrom.providers[provider];
      else config.providers[provider].accounts = config.providers[provider].accounts
        .filter(a => a.credential.type !== 'remote');
      const ids = new Set(config.providers[provider].accounts.map(a => a.id));
      for (const key of ['activeAccountId', 'pinnedAccountId']) {
        if (config.providers[provider][key] && !ids.has(config.providers[provider][key])) config.providers[provider][key] = null;
      }
    }
  }, stateDir);
  const { unlinkSync } = await import('node:fs');
  try { unlinkSync(join(stateDir, REMOTE_FILE)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  return { restored: !!restoredFrom };
}
