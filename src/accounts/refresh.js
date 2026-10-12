// Only an explicitly transferred, private managed credential may be refreshed.
// External stores belong to their native client. Never spend their refresh token.
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { STATE_DIR } from '../config.js';
import { readCredential } from './credentials.js';
import { readPrivateJson, atomicPrivateJson, withStoreLock } from './store.js';
import { mutateAccounts } from './config.js';

export class CredentialUnavailable extends Error {
  constructor(code = 'expired_login') {
    super(code === 'network_error' ? 'Credential service unavailable.' : 'Account requires login.');
    this.code = code;
  }
}

export async function routingCredential(provider, account, {
  now = Date.now(), fetchFn = fetch, timeoutMs = 15000,
  tokenUrl = 'https://auth.openai.com/oauth/token',
} = {}) {
  const initial = readCredential(account);
  if (!initial.expiresAt || initial.expiresAt > now + 30000) return initial;
  if (provider !== 'codex' || account.credential.type !== 'managed') {
    throw new CredentialUnavailable();
  }
  return withStoreLock(account.credential.path, async () => {
    const saved = readPrivateJson(account.credential.path);
    const current = readCredential(account);
    if (saved.refreshPending) throw new CredentialUnavailable();
    if (!current.expiresAt || current.expiresAt > now + 30000) return current;
    if (!current.refreshToken) throw new CredentialUnavailable();
    // A durable intent precedes the non-idempotent OAuth exchange. A crash or
    // lost response leaves this set: re-login is safer than reusing the token.
    atomicPrivateJson(account.credential.path, { ...saved, refreshPending: {
      at: now, digest: createHash('sha256').update(current.refreshToken).digest('hex'),
    } });
    let response;
    try {
      response = await fetchFn(tokenUrl, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: current.refreshToken,
          client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' }),
      });
    } catch { throw new CredentialUnavailable('network_error'); }
    let data;
    try { data = await response.json(); } catch { throw new CredentialUnavailable(); }
    if (!response.ok || typeof data.access_token !== 'string' || !data.access_token
      || typeof data.refresh_token !== 'string' || !data.refresh_token
      || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
      throw new CredentialUnavailable();
    }
    const next = { ...current, accessToken: data.access_token, refreshToken: data.refresh_token,
      expiresAt: now + data.expires_in * 1000,
      ...(typeof data.id_token === 'string' ? { idToken: data.id_token } : {}) };
    atomicPrivateJson(account.credential.path, next);
    return next;
  });
}

// Invoke only after external refresh owners have stopped. Access-token-only
// routing and usage work before this handoff, using the live external refs.
export async function takeCodexOwnership({ stateDir = STATE_DIR } = {}) {
  let count = 0;
  await mutateAccounts(config => {
    for (const account of config.providers.codex?.accounts || []) {
      if (account.credential.type === 'managed') continue;
      const credential = readCredential(account);
      const path = join(stateDir, 'credentials', `codex-${account.id}.json`);
      atomicPrivateJson(path, credential);
      account.credential = { type: 'managed', path };
      count += 1;
    }
  }, stateDir);
  return count;
}
