import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { STATE_DIR } from '../config.js';
import { atomicPrivateJson, readPrivateJson, withStoreLock } from './store.js';

const validId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id);
const validLaunch = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);

export function sessionIdentity(headers) {
  const raw = headers.session_id || headers['session-id'] || headers.conversation_id;
  const sessionId = validId(raw) ? raw : null;
  const launchId = validLaunch(headers['x-unsnooze-launch']) ? headers['x-unsnooze-launch'] : null;
  return { sessionId, launchId };
}

export function resumeRequestPath(launchId, stateDir = STATE_DIR) {
  if (!validLaunch(launchId)) throw new Error('Invalid managed launch identity.');
  return join(stateDir, 'resume-requests', `${launchId}.json`);
}

// Persist only identities, never prompts or response contents. A previous
// response belongs to its account even if another session changes global active.
export async function claimSessionAccount(provider, accountId, headers, {
  stateDir = STATE_DIR, chained = false, now = Date.now(),
} = {}) {
  const { sessionId, launchId } = sessionIdentity(headers);
  const identity = sessionId || launchId;
  if (!identity) return !chained;
  const key = createHash('sha256').update(`${provider}:${identity}`).digest('hex');
  const path = join(stateDir, 'affinity', `${key}.json`);
  return withStoreLock(path, async () => {
    const previous = readPrivateJson(path, null);
    if (chained && previous?.accountId !== accountId) {
      if (launchId && sessionId) atomicPrivateJson(resumeRequestPath(launchId, stateDir), {
        provider, sessionId, accountId, requestedAt: now, phase: 'pending',
      });
      return false;
    }
    atomicPrivateJson(path, { accountId, sessionId, launchId, updatedAt: now });
    return true;
  });
}

export function readResumeRequest(launchId, stateDir = STATE_DIR) {
  const request = readPrivateJson(resumeRequestPath(launchId, stateDir), null);
  if (!request) return null;
  if (!validId(request.sessionId) || !['claude', 'codex'].includes(request.provider)
    || !Number.isFinite(request.requestedAt) || !['pending', 'resuming'].includes(request.phase)) {
    throw new Error('Invalid managed resume request.');
  }
  return request;
}

export function exactResumeArgs(provider, sessionId) {
  if (!validId(sessionId)) throw new Error('A known conversation is required.');
  const message = 'Continue where you left off in this same conversation after the account switch.';
  if (provider === 'codex') return ['resume', sessionId, message];
  if (provider === 'claude') return ['--resume', sessionId, message];
  throw new Error('Unsupported managed conversation.');
}

export async function runRoutedConversation(provider, args, {
  launchId, stateDir = STATE_DIR, run, buildOptions, intervalMs = 500,
} = {}) {
  let nextArgs = args;
  for (;;) {
    let child = null, pending = null;
    const started = Date.now();
    const check = () => {
      if (!child || pending) return;
      const request = readResumeRequest(launchId, stateDir);
      if (!request || request.phase !== 'pending' || request.provider !== provider || request.requestedAt < started) return;
      pending = request;
      atomicPrivateJson(resumeRequestPath(launchId, stateDir), { ...request, phase: 'resuming' });
      child.kill('SIGTERM');
    };
    const timer = setInterval(() => { try { check(); } catch { /* hold on invalid state */ } }, intervalMs);
    timer.unref();
    const options = buildOptions(nextArgs);
    let code;
    try {
      code = await run(options.args, provider, { forceWatch: true, childEnv: options.env,
        binOverride: options.bin, onChild: p => { child = p; } });
    } finally { clearInterval(timer); }
    if (!pending) return code;
    nextArgs = exactResumeArgs(provider, pending.sessionId);
  }
}
