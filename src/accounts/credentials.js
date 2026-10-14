import { readPrivateText } from './store.js';

// External credentials are references, never owned by this process. In
// particular, reading a reference must not chmod it or rotate its refresh token.
const MAX_CREDENTIAL_BYTES = 4 * 1024 * 1024;

export class CredentialError extends Error {
  constructor(code = 'invalid_credential') {
    super(code === 'credential_unavailable'
      ? 'Credential file is unavailable.'
      : 'Credential data is invalid or the selected account is missing.');
    this.name = 'CredentialError';
    this.code = code;
  }
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function token(value, required = false) {
  if (typeof value !== 'string' || !value.trim() || /[\s\x00-\x1f\x7f]/.test(value.trim())) {
    if (required) throw new CredentialError();
    return undefined;
  }
  return value.trim();
}

export function credentialExpiry(value) {
  if (value == null) return undefined;
  const n = typeof value === 'string' && !/^\d+(\.\d+)?$/.test(value)
    ? Date.parse(value) : Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n < 1e12 ? n * 1000 : n;
}

function tokenExpiry(accessToken) {
  try {
    const parts = accessToken.split('.');
    if (parts.length !== 3) return undefined;
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    // This is only an early expiry check, never signature verification.
    return typeof claims.exp === 'number' ? credentialExpiry(claims.exp) : undefined;
  } catch { return undefined; }
}

function normalize(data) {
  if (!record(data)) throw new CredentialError();
  const accessToken = token(data.accessToken ?? data.access_token, true);
  const refreshToken = token(data.refreshToken ?? data.refresh_token);
  const idToken = token(data.idToken ?? data.id_token);
  const accountId = token(data.accountId ?? data.account_id);
  const rawExpiry = data.expiresAt ?? data.expires_at ?? data.expiry;
  const expiresAt = credentialExpiry(rawExpiry) ?? tokenExpiry(accessToken);
  if (rawExpiry != null && credentialExpiry(rawExpiry) === undefined) throw new CredentialError();
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(idToken ? { idToken } : {}),
    ...(accountId ? { accountId } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

export function readCredential(account) {
  const ref = account?.credential;
  if (!record(ref) || typeof ref.path !== 'string' || !ref.path) throw new CredentialError();
  // The account host holds this login; nothing local may read it.
  if (ref.type === 'remote') throw new CredentialError('credential_unavailable');
  let raw;
  try {
    raw = readPrivateText(ref.path);
    if (Buffer.byteLength(raw) > MAX_CREDENTIAL_BYTES) throw new CredentialError();
  } catch (err) {
    if (err instanceof CredentialError) throw err;
    throw new CredentialError('credential_unavailable');
  }
  if (ref.type === 'claude-token') return normalize({ accessToken: raw.trim() });

  let data;
  try { data = JSON.parse(raw); } catch { throw new CredentialError(); }
  if (!record(data)) throw new CredentialError();
  if (ref.type === 'codex-multi-auth') {
    if (!Array.isArray(data.accounts)) throw new CredentialError();
    const selected = ref.recordId != null
      ? data.accounts.filter(a => record(a) && a.recordId === ref.recordId)
      : data.accounts;
    // An absent or ambiguous selector must not silently read another login.
    if (selected.length !== 1 || !record(selected[0])) throw new CredentialError();
    const chosen = selected[0];
    const index = chosen.currentWorkspaceIndex;
    const workspace = Number.isInteger(index) && index >= 0 ? chosen.workspaces?.[index] : undefined;
    if (index != null && (!workspace || !token(workspace.id))) throw new CredentialError();
    return normalize({ ...chosen, accountId: workspace?.id ?? chosen.accountId });
  }
  if (ref.type === 'agy-token') {
    if (!record(data.token)) throw new CredentialError();
    return normalize({ ...data.token, idToken: data.id_token ?? data.token.id_token });
  }
  if (ref.type === 'managed') return normalize(data);
  throw new CredentialError();
}
