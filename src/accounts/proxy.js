import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { openSync, closeSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { STATE_DIR } from '../config.js';
import { selectRoutingAccount, recordAccountFailure } from './routing.js';
import { routingCredential } from './refresh.js';
import { recordUsageHeaders } from './usage.js';
import { claimSessionAccount } from './sessions.js';
import { readPrivateText } from './store.js';

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'cookie', 'set-cookie',
  'authorization', 'x-api-key', 'x-openai-actor-authorization', 'chatgpt-account-id', 'x-unsnooze-launch']);

export function routerToken(stateDir = STATE_DIR) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, 'router-token');
  try {
    const fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, randomBytes(32).toString('base64url')); } finally { closeSync(fd); }
  } catch (error) { if (error.code !== 'EEXIST') throw new Error('Cannot create router credential.'); }
  const value = readPrivateText(path).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('Router credential is invalid.');
  return value;
}

function authorized(req, token) {
  const raw = req.headers.authorization || req.headers['x-api-key'] || '';
  const value = String(raw).replace(/^Bearer\s+/i, '');
  const a = Buffer.from(value), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function upstreamRoute(rawPath) {
  if (typeof rawPath !== 'string' || /(?:\\|%2f|%5c|\.\.)/i.test(rawPath)) return null;
  const url = new URL(rawPath, 'http://localhost');
  if (url.origin !== 'http://localhost') return null;
  if (url.pathname.startsWith('/claude/')) {
    const path = url.pathname.slice('/claude'.length);
    if (!['/v1/messages', '/v1/messages/count_tokens', '/v1/models'].includes(path)) return null;
    return { provider: 'claude', path: path + url.search };
  }
  if (url.pathname.startsWith('/codex/')) {
    let path = url.pathname.slice('/codex'.length).replace(/^\/v1\//, '/');
    if (path.startsWith('/codex/')) path = path.slice('/codex'.length);
    if (['/responses', '/responses/compact', '/images/generations', '/images/edits',
      '/models', '/thread/goal'].includes(path)) {
      return { provider: 'codex', path: (path === '/models' ? path : '/codex' + path) + url.search };
    }
  }
  return null;
}

export function upstreamHeaders(reqHeaders, provider, credential) {
  const headers = new Headers();
  const nominated = String(reqHeaders.connection || '').toLowerCase().split(',').map(x => x.trim());
  for (const [key, value] of Object.entries(reqHeaders)) {
    if (value == null || HOP_HEADERS.has(key.toLowerCase()) || nominated.includes(key.toLowerCase())) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  headers.set('authorization', `Bearer ${credential.accessToken}`);
  headers.set('accept-encoding', 'identity');
  if (provider === 'claude') {
    headers.set('anthropic-version', headers.get('anthropic-version') || '2023-06-01');
    const beta = (headers.get('anthropic-beta') || '').split(',').filter(Boolean);
    if (!beta.includes('oauth-2025-04-20')) beta.push('oauth-2025-04-20');
    headers.set('anthropic-beta', beta.join(','));
  } else {
    if (credential.accountId) headers.set('chatgpt-account-id', credential.accountId);
    headers.set('openai-beta', 'responses=experimental');
    headers.set('originator', 'codex_cli_rs');
  }
  return headers;
}

function reply(res, status, code, message, retryAt) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
    ...(retryAt ? { 'retry-after': String(Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))) } : {}) });
  res.end(JSON.stringify({ type: 'error', error: { type: code, code, message } }));
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Request too large.'), { code: 'body_size' });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function rateReset(headers, now) {
  const seconds = Number(headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? now + Math.min(seconds, 604800) * 1000 : now + 30000;
}

export function isQuotaRejection(provider, headers, body) {
  if (provider === 'claude') {
    return headers.get('anthropic-ratelimit-unified-status') === 'rejected'
      && ['5h', '7d'].some(w => headers.get(`anthropic-ratelimit-unified-${w}-status`) === 'rejected'
        || Number(headers.get(`anthropic-ratelimit-unified-${w}-utilization`)) >= 1);
  }
  if (['primary', 'secondary'].some(w => Number(headers.get(`x-codex-${w}-used-percent`)) >= 100)) return true;
  try {
    const error = JSON.parse(body)?.error;
    return ['usage_limit_reached', 'usage_limit_exceeded', 'quota_exceeded'].includes(error?.type)
      || ['usage_limit_reached', 'usage_limit_exceeded', 'quota_exceeded'].includes(error?.code);
  } catch { return false; }
}

// No request is replayed after upstream success/streaming starts. Retrying a
// rejected request is safe; replaying a half-delivered model/tool call is not.
export async function startAccountProxy({ stateDir = STATE_DIR, host = '127.0.0.1', port = 18484,
  health = () => ({}), fetchFn = fetch, selectFn = selectRoutingAccount,
  credentialFn = routingCredential, failureFn = recordAccountFailure,
  usageHeadersFn = recordUsageHeaders,
  upstreams = { claude: 'https://api.anthropic.com', codex: 'https://chatgpt.com/backend-api' },
  maxBodyBytes = 32 * 1024 * 1024, requestTimeoutMs = 15 * 60 * 1000,
} = {}) {
  if (host !== '127.0.0.1') throw new Error('Account router only binds loopback.');
  const token = routerToken(stateDir);
  const server = http.createServer(async (req, res) => {
    if (!authorized(req, token)) return reply(res, 401, 'authentication_error', 'Router authentication required.');
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, service: 'unsnooze-accounts', pid: process.pid, ...health() }));
    }
    const route = upstreamRoute(req.url);
    if (!route || !['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) {
      return reply(res, 404, 'not_found', 'Unsupported provider route.');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    timeout.unref();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    try {
      const body = await readBody(req, maxBodyBytes);
      let payload;
      try { payload = JSON.parse(body.toString('utf8')); } catch { /* binary image body or GET */ }
      const exclude = [];
      let lastFailure = null;
      for (let attempt = 0; attempt < 32; attempt++) {
        const selected = await selectFn(route.provider, { stateDir, exclude, refresh: attempt > 0,
          reason: lastFailure === 'quota_exhausted' ? 'limit' : 'request', model: payload?.model });
        if (!selected.account) {
          const expired = selected.status === 'expired_login' || lastFailure === 'expired_login' || /expired|auth|login/.test(selected.reason || '');
          const quota = selected.status === 'quota_exhausted' || lastFailure === 'quota_exhausted' || /exhaust|limit/.test(selected.reason || '');
          return reply(res, expired ? 401 : quota ? 429 : 503,
            expired ? 'authentication_error' : quota ? 'usage_limit_reached' : 'provider_unavailable',
            expired ? 'Account login expired. Sign in again.' : quota
              ? "You've hit your usage limit. Unsnooze is waiting for verified quota to return."
              : 'Account usage cannot be verified. Retry when the provider is available.', selected.retryAt);
        }
        const account = selected.account;
        let credential;
        try { credential = await credentialFn(route.provider, account); }
        catch (error) {
          lastFailure = error.code === 'network_error' ? 'network_error' : 'expired_login';
          await failureFn(route.provider, account.id, lastFailure, { stateDir });
          exclude.push(account.id);
          continue;
        }
        // Incremental server-side response chains belong to one account. Do not
        // pretend that removing previous_response_id reconstructs a transcript.
        if (!(await claimSessionAccount(route.provider, account.id, req.headers, {
          stateDir, chained: !!payload?.previous_response_id,
        }))) {
          return reply(res, 409, 'session_resume_required',
            'Account changed. Resume this same CLI conversation to resend its full transcript.');
        }
        const upstream = await fetchFn(upstreams[route.provider] + route.path, {
          method: req.method, headers: upstreamHeaders(req.headers, route.provider, credential),
          ...(body.length ? { body } : {}), signal: controller.signal, redirect: 'error',
        });
        try { await usageHeadersFn(route.provider, account.id, upstream.headers, { stateDir }); }
        catch { /* quota telemetry cannot turn accepted work into a retry */ }
        if (upstream.status === 401 || upstream.status === 429) {
          if (upstream.status === 429) {
            const errorBody = await upstream.text();
            if (!isQuotaRejection(route.provider, upstream.headers, errorBody)) {
              return reply(res, 429, 'rate_limit_error', 'Server is temporarily busy. Retry shortly.',
                rateReset(upstream.headers, Date.now()));
            }
          }
          // Bodies are deliberately not returned/logged: OAuth errors sometimes
          // echo a credential. Record only status and bounded retry time.
          if (!upstream.bodyUsed) await upstream.body?.cancel();
          lastFailure = upstream.status === 401 ? 'expired_login' : 'quota_exhausted';
          await failureFn(route.provider, account.id, lastFailure, {
            stateDir, retryAt: rateReset(upstream.headers, Date.now()),
          });
          exclude.push(account.id);
          continue;
        }
        if (!upstream.ok) {
          await upstream.body?.cancel();
          return reply(res, upstream.status, upstream.status === 403 ? 'permission_error' : 'provider_error',
            upstream.status === 403 ? 'Provider denied account access.' : 'Provider request failed.');
        }
        const headers = {};
        for (const [key, value] of upstream.headers) {
          if (!HOP_HEADERS.has(key) && key !== 'content-encoding') headers[key] = value;
        }
        res.writeHead(upstream.status, headers);
        if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res);
        else res.end();
        return;
      }
      reply(res, 503, 'provider_unavailable', 'No available account.');
    } catch (error) {
      reply(res, error.code === 'body_size' ? 413 : 502, 'router_error',
        error.code === 'body_size' ? 'Request exceeds router size limit.' : 'Provider connection unavailable.');
    } finally { clearTimeout(timeout); }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 15000;
  server.on('upgrade', (_req, socket) => { socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n'); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return { server, port: server.address().port,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
