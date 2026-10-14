// A detached supervisor owns one worker, which owns the router and a legacy
// watcher. Health is authenticated and tied to both process generations.
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  readFileSync, mkdirSync, chmodSync, openSync, closeSync, constants, unlinkSync,
} from 'node:fs';
import { request } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE_DIR } from '../config.js';
import { standaloneEnv } from '../spawn.js';
import { atomicPrivateJson, readPrivateJson, readPrivateText, withStoreLock } from './store.js';

export const ACCOUNT_DAEMON_PORT = 18484;
export const ACCOUNT_HEARTBEAT_MS = 1_000;
export const ACCOUNT_STALE_MS = 15_000;
const BIN = fileURLToPath(new URL('../../bin/unsnooze.js', import.meta.url));
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const validPid = pid => Number.isInteger(pid) && pid > 0;

function paths(stateDir) {
  return {
    metadata: join(stateDir, 'account-daemon.json'),
    supervisor: join(stateDir, 'account-supervisor.json'),
    stop: join(stateDir, 'account-daemon-stop.json'),
    control: join(stateDir, 'account-daemon-control'),
    token: join(stateDir, 'router-token'),
    log: join(stateDir, 'account-daemon.log'),
  };
}

// Torn or manually damaged metadata is not process identity. Credential and
// permission errors still propagate; only disposable daemon JSON is tolerated.
function readDaemonJson(file) {
  try { return readPrivateJson(file, null); }
  catch (err) { if (err.code === 'INVALID_JSON') return null; throw err; }
}

function privateDirectory(stateDir) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(stateDir, 0o700);
}

function configuredPort(port = process.env.UNSNOOZE_ROUTER_PORT ?? ACCOUNT_DAEMON_PORT) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('Router port must be between 1 and 65535');
  return value;
}

function alive(pid) {
  if (!validPid(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// Include the Linux boot identity: a reboot can reuse both PID and start tick.
// Windows creation time comes from CIM, never from a PID-only task listing.
export function accountProcessBirth(pid, {
  platform = process.platform,
  readFile = file => readFileSync(file, 'utf8'),
  execFile = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 2_000,
    stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }),
} = {}) {
  if (!validPid(pid)) return null;
  try {
    if (platform === 'linux') {
      const stat = readFile(`/proc/${pid}/stat`);
      const close = stat.lastIndexOf(')');
      const fields = close >= 0 ? stat.slice(close + 1).trim().split(/\s+/) : [];
      if (fields[0] === 'Z') return null; // exited, pending its parent's wait()
      const tick = fields[19];
      return tick ? `${readFile('/proc/sys/kernel/random/boot_id').trim()}:${tick}` : null;
    }
    if (platform === 'darwin') return execFile('ps', ['-o', 'lstart=', '-p', String(pid)]).trim() || null;
    if (platform === 'win32') {
      return execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CreationDate.ToUniversalTime().ToString('o')`]).trim() || null;
    }
  } catch { /* unavailable identity is never authority to signal a process */ }
  return null;
}

function ownedProcess(record, { birth = accountProcessBirth, isAlive = alive } = {}) {
  if (!record || !isAlive(record.pid)) return false;
  const current = birth(record.pid);
  if (record.pidBirth || current) return Boolean(record.pidBirth && current === record.pidBirth);
  // Platforms without a process creation time retain a bounded heartbeat
  // claim. Stop requests go through the private identity file, not kill(pid).
  return Number.isFinite(record.heartbeatAt) && Date.now() - record.heartbeatAt <= ACCOUNT_STALE_MS;
}

function sameOwner(a, b) {
  return Boolean(a && b && a.instanceId === b.instanceId && a.pid === b.pid
    && a.pidBirth === b.pidBirth);
}

function removeOwned(file, predicate) {
  const current = readDaemonJson(file);
  if (!predicate(current)) return;
  try { unlinkSync(file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
}

function readToken(file) {
  return readPrivateText(file).trim();
}

export function requestAccountHealth({ port, token, timeoutMs = 800 } = {}) {
  return new Promise(resolveHealth => {
    let settled = false;
    let timer;
    const finish = result => {
      if (!settled) { settled = true; clearTimeout(timer); resolveHealth(result); }
    };
    const req = request({
      hostname: '127.0.0.1', port, path: '/health', method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        data += chunk;
        if (data.length > 16_384) { req.destroy(); finish(null); }
      });
      res.on('error', () => finish(null));
      res.on('end', () => {
        if (res.statusCode !== 200) return finish(null);
        try { finish(JSON.parse(data)); } catch { finish(null); }
      });
    });
    req.on('error', () => finish(null));
    // A trickling or wedged local listener must not hold ensure/the supervisor
    // indefinitely. Socket inactivity alone is not a request deadline.
    timer = setTimeout(() => { req.destroy(); finish(null); }, timeoutMs);
    req.end();
  });
}

export async function accountDaemonStatus({
  stateDir = STATE_DIR, now = Date.now(), staleMs = ACCOUNT_STALE_MS,
  healthTimeoutMs = 800, healthRequest = requestAccountHealth,
} = {}) {
  const files = paths(stateDir);
  const metadata = readDaemonJson(files.metadata);
  const supervisor = readDaemonJson(files.supervisor);
  const base = { running: false, healthy: false, metadata, supervisor };
  if (!metadata || !validPid(metadata.pid) || !validPid(metadata.supervisorPid)
    || !metadata.instanceId || !metadata.workerId
    || !Number.isInteger(metadata.port) || metadata.port < 1 || metadata.port > 65535) {
    return { ...base, reason: 'no-worker' };
  }
  if (!supervisor || supervisor.instanceId !== metadata.instanceId
    || supervisor.pid !== metadata.supervisorPid || !ownedProcess(supervisor)
    || !Number.isFinite(supervisor.heartbeatAt) || now - supervisor.heartbeatAt > staleMs
    || supervisor.heartbeatAt > now + 5_000) {
    return { ...base, reason: 'no-supervisor' };
  }
  if (!Number.isFinite(metadata.heartbeatAt) || now - metadata.heartbeatAt > staleMs
    || metadata.heartbeatAt > now + 5_000 || !ownedProcess(metadata)) {
    return { ...base, reason: 'stale-worker' };
  }
  let token;
  try { token = readToken(files.token); } catch { return { ...base, reason: 'missing-token' }; }
  if (!token) return { ...base, reason: 'missing-token' };
  let health;
  try { health = await healthRequest({ port: metadata.port, token, timeoutMs: healthTimeoutMs }); }
  catch { health = null; }
  const healthy = health?.ok === true && health.service === 'unsnooze-accounts'
    && health.pid === metadata.pid && health.supervisorPid === metadata.supervisorPid
    && health.instanceId === metadata.instanceId && health.workerId === metadata.workerId;
  return { ...base, running: healthy, healthy, reason: healthy ? null : 'health-check-failed',
    ...(healthy ? { pid: metadata.pid, supervisorPid: metadata.supervisorPid, port: metadata.port } : {}) };
}

function processEnvironment(stateDir, port, extra = {}) {
  return { ...standaloneEnv(process.env), UNSNOOZE_STATE_DIR: stateDir,
    UNSNOOZE_ROUTER_PORT: String(port), ...extra };
}

function spawnLogged(args, { stateDir, port, env = {}, detached = false, ipc = false } = {}) {
  const fd = openSync(paths(stateDir).log,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: stateDir, detached, windowsHide: true,
      stdio: ipc ? ['ignore', fd, fd, 'ipc'] : ['ignore', fd, fd],
      env: processEnvironment(stateDir, port, env),
    });
    child.on('error', () => {}); // startup health/exit handling reports failures
    if (detached) child.unref();
    return child;
  } finally { closeSync(fd); }
}

export async function ensureAccountDaemon({
  stateDir = STATE_DIR, port, timeoutMs = 12_000, pollMs = 75,
  readAccounts, spawnSupervisor, healthRequest, heartbeatMs = ACCOUNT_HEARTBEAT_MS,
} = {}) {
  stateDir = resolve(stateDir);
  port = configuredPort(port);
  if (!readAccounts) ({ readAccounts } = await import('./config.js'));
  const accounts = readAccounts(stateDir);
  const configured = Object.values(accounts?.providers ?? {}).some(p => p.accounts?.some(a => a.enabled !== false));
  if (!configured) return { running: false, healthy: false, disabled: true, reason: 'no-accounts' };
  privateDirectory(stateDir);
  const files = paths(stateDir);
  let status = await accountDaemonStatus({ stateDir, healthRequest });
  if (status.healthy && status.port === port) return status;
  await withStoreLock(files.control, async () => {
    status = await accountDaemonStatus({ stateDir, healthRequest });
    if (status.healthy) {
      if (status.port !== port) throw new Error(`Account daemon is already running on port ${status.port}; stop it before changing the port`);
      return;
    }
    const owner = readDaemonJson(files.supervisor);
    if (ownedProcess(owner)) return; // the supervisor is repairing its worker
    const instanceId = randomUUID();
    const startedAt = Date.now();
    const child = (spawnSupervisor ?? (options => spawnLogged(['_account-supervisor'], {
      ...options, detached: true,
      env: { UNSNOOZE_ACCOUNT_INSTANCE: instanceId, UNSNOOZE_ACCOUNT_HEARTBEAT_MS: String(heartbeatMs) },
    })))({ stateDir, port, instanceId, heartbeatMs });
    if (!validPid(child?.pid)) throw new Error('Could not start the account supervisor');
    atomicPrivateJson(files.supervisor, {
      version: 1, instanceId, pid: child.pid, pidBirth: accountProcessBirth(child.pid),
      port, startedAt, heartbeatAt: startedAt,
    });
  });
  const deadline = Date.now() + timeoutMs;
  do {
    status = await accountDaemonStatus({ stateDir, healthRequest });
    if (status.healthy && status.port === port) return status;
    await sleep(pollMs);
  } while (Date.now() < deadline);
  throw new Error(`Account daemon did not become healthy (${status.reason}); see ${files.log}`);
}

function shutdownController(signal, { parent = false } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  process.on('SIGTERM', abort);
  process.on('SIGINT', abort);
  if (parent) process.on('disconnect', abort);
  return { controller, cleanup() {
    signal?.removeEventListener('abort', abort);
    process.off('SIGTERM', abort);
    process.off('SIGINT', abort);
    if (parent) process.off('disconnect', abort);
  } };
}

async function pause(ms, signal) {
  if (signal.aborted) return;
  await new Promise(done => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); done(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

async function terminateChild(child, timeoutMs = 1_500) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !validPid(child.pid)) return;
  // IPC requests allow graceful shutdown on Windows, where SIGTERM is forced.
  try { if (child.connected) child.send({ type: 'unsnooze-stop' }); else child.kill('SIGTERM'); }
  catch { /* already exiting */ }
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(25);
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

export async function runAccountSupervisor({
  stateDir = STATE_DIR, port,
  instanceId = process.env.UNSNOOZE_ACCOUNT_INSTANCE || randomUUID(),
  heartbeatMs = Number(process.env.UNSNOOZE_ACCOUNT_HEARTBEAT_MS) || ACCOUNT_HEARTBEAT_MS,
  restartBaseMs = 250, restartMaxMs = 15_000, stableMs = 30_000,
  healthGraceMs = 10_000, healthCheckMs = 2_000, signal, spawnWorker,
} = {}) {
  stateDir = resolve(stateDir);
  port = configuredPort(port);
  privateDirectory(stateDir);
  const files = paths(stateDir);
  const self = { version: 1, instanceId, pid: process.pid, pidBirth: accountProcessBirth(process.pid),
    port, startedAt: Date.now(), heartbeatAt: Date.now() };
  const claimed = await withStoreLock(files.control, async () => {
    const previous = readDaemonJson(files.supervisor);
    if (previous && !sameOwner(previous, self) && ownedProcess(previous)) return false;
    atomicPrivateJson(files.supervisor, self);
    return true;
  });
  if (!claimed) return 0;
  const shutdown = shutdownController(signal);
  const { controller } = shutdown;
  let worker = null;
  let failures = 0;
  let exited = true;
  let workerStartedAt = 0;
  let nextStartAt = 0;
  let nextHealthAt = 0;
  let unhealthySince = null;
  const stopMessage = message => { if (message?.type === 'unsnooze-stop') controller.abort(); };
  process.on('message', stopMessage);
  try {
    while (!controller.signal.aborted) {
      let retained = false;
      await withStoreLock(files.control, async () => {
        if (!sameOwner(readDaemonJson(files.supervisor), self)) return;
        if (readDaemonJson(files.stop)?.instanceId === instanceId) return;
        self.heartbeatAt = Date.now();
        atomicPrivateJson(files.supervisor, self);
        retained = true;
      });
      if (!retained) break;
      if (exited && Date.now() >= nextStartAt) {
        const workerId = randomUUID();
        exited = false;
        workerStartedAt = Date.now();
        unhealthySince = null;
        nextHealthAt = workerStartedAt + healthGraceMs;
        let generation;
        const onExit = () => {
          if (exited || (generation && worker !== generation)) return;
          exited = true;
          failures = Date.now() - workerStartedAt >= stableMs ? 0 : failures + 1;
          nextStartAt = Date.now() + Math.min(restartMaxMs, restartBaseMs * 2 ** Math.min(Math.max(0, failures - 1), 16));
        };
        try {
          generation = (spawnWorker ?? (options => spawnLogged(['_account-worker'], {
            ...options, ipc: true,
            env: { UNSNOOZE_ACCOUNT_INSTANCE: instanceId, UNSNOOZE_ACCOUNT_WORKER: workerId,
              UNSNOOZE_ACCOUNT_SUPERVISOR_PID: String(process.pid),
              UNSNOOZE_ACCOUNT_HEARTBEAT_MS: String(heartbeatMs) },
          })))({ stateDir, port, instanceId, workerId, supervisorPid: process.pid, heartbeatMs });
          worker = generation;
          worker.once('exit', onExit);
          worker.once('error', onExit);
          if (!validPid(worker.pid)) onExit();
        } catch { onExit(); }
      }
      if (!exited && Date.now() >= nextHealthAt) {
        const status = await accountDaemonStatus({ stateDir });
        nextHealthAt = Date.now() + healthCheckMs;
        if (status.healthy) unhealthySince = null;
        else {
          unhealthySince ??= Date.now();
          if (Date.now() - unhealthySince >= healthGraceMs) await terminateChild(worker);
        }
      }
      await pause(heartbeatMs, controller.signal);
    }
  } finally {
    controller.abort();
    try {
      await terminateChild(worker);
      await withStoreLock(files.control, async () => {
        removeOwned(files.supervisor, current => sameOwner(current, self));
        removeOwned(files.metadata, current => current?.instanceId === instanceId);
        removeOwned(files.stop, current => current?.instanceId === instanceId);
      });
    } finally {
      process.off('message', stopMessage);
      shutdown.cleanup();
    }
  }
  return 0;
}

export async function runAccountWorker({
  stateDir = STATE_DIR, port,
  instanceId = process.env.UNSNOOZE_ACCOUNT_INSTANCE,
  workerId = process.env.UNSNOOZE_ACCOUNT_WORKER,
  supervisorPid = Number(process.env.UNSNOOZE_ACCOUNT_SUPERVISOR_PID),
  heartbeatMs = Number(process.env.UNSNOOZE_ACCOUNT_HEARTBEAT_MS) || ACCOUNT_HEARTBEAT_MS,
  reconcileMs = Number(process.env.UNSNOOZE_ACCOUNT_RECONCILE_MS) || 30_000,
  versionCheckMs = 15 * 60_000, signal, startProxy, startLegacy, reconcile, hasVersionSkew, syncRemote,
} = {}) {
  stateDir = resolve(stateDir);
  port = configuredPort(port);
  const files = paths(stateDir);
  const owner = readDaemonJson(files.supervisor);
  if (!instanceId || !workerId || !owner || owner.instanceId !== instanceId
    || owner.pid !== supervisorPid || !ownedProcess(owner)) return 1;
  const shutdown = shutdownController(signal, { parent: true });
  const { controller } = shutdown;
  const stopMessage = message => { if (message?.type === 'unsnooze-stop') controller.abort(); };
  process.on('message', stopMessage);
  const metadata = { version: 1, instanceId, workerId, pid: process.pid,
    pidBirth: accountProcessBirth(process.pid), supervisorPid, port, tokenFile: files.token,
    startedAt: Date.now(), heartbeatAt: Date.now() };
  let proxy;
  let legacy = null;
  let legacyExited = true;
  let legacyFailures = 0;
  let legacyStartedAt = 0;
  let nextLegacyAt = 0;
  let reconciliation = null;
  let nextReconcileAt = 0;
  let nextVersionCheckAt = Date.now() + versionCheckMs;
  try {
    if (!startProxy) ({ startAccountProxy: startProxy } = await import('./proxy.js'));
    if (!reconcile) ({ reconcileAccountSessions: reconcile } = await import('./reconcile.js'));
    if (!hasVersionSkew) ({ hasVersionSkew } = await import('../update-check.js'));
    if (!syncRemote) ({ syncRemoteAccounts: syncRemote } = await import('./remote.js'));
    proxy = await startProxy({ stateDir, host: '127.0.0.1', port,
      health: () => ({ instanceId, workerId, supervisorPid, heartbeatAt: metadata.heartbeatAt }) });
    if (proxy.port !== port) throw new Error('Account router did not bind the configured port');
    while (!controller.signal.aborted) {
      let retained = false;
      await withStoreLock(files.control, async () => {
        const current = readDaemonJson(files.supervisor);
        if (!sameOwner(current, owner) || !ownedProcess(current)
          || readDaemonJson(files.stop)?.instanceId === instanceId) return;
        metadata.heartbeatAt = Date.now();
        atomicPrivateJson(files.metadata, metadata);
        retained = true;
      });
      if (!retained) break;
      if (Date.now() >= nextVersionCheckAt) {
        if (hasVersionSkew()) break;
        nextVersionCheckAt = Date.now() + versionCheckMs;
      }
      if (legacyExited && Date.now() >= nextLegacyAt) {
        legacyExited = false;
        legacyStartedAt = Date.now();
        let generation;
        const onExit = () => {
          if (legacyExited || (generation && legacy !== generation)) return;
          legacyExited = true;
          legacyFailures = Date.now() - legacyStartedAt > 30_000 ? 0 : legacyFailures + 1;
          nextLegacyAt = Date.now() + Math.min(15_000, 250 * 2 ** Math.min(legacyFailures, 6));
        };
        try {
          generation = (startLegacy ?? (options => spawnLogged(['daemon'], {
            ...options, ipc: true, env: { UNSNOOZE_LEGACY_DAEMON: '1', UNSNOOZE_ACCOUNT_CHILD: '1' },
          })))({ stateDir, port });
          legacy = generation;
          if (legacy) { legacy.once('exit', onExit); legacy.once('error', onExit); }
          else onExit();
        } catch { onExit(); }
      }
      if (!reconciliation && Date.now() >= nextReconcileAt) {
        // Remote mode mirrors the host's account metadata first; a failed sync
        // keeps the previous mirror and never blocks reconciliation.
        reconciliation = Promise.resolve().then(() => syncRemote(stateDir)).catch(() => {})
          .then(() => reconcile({ stateDir }))
          .catch(() => {}) // failed usage evidence never wakes a session
          .finally(() => { reconciliation = null; nextReconcileAt = Date.now() + reconcileMs; });
      }
      await pause(heartbeatMs, controller.signal);
    }
  } finally {
    controller.abort();
    try {
      await terminateChild(legacy);
      await proxy?.close();
      await withStoreLock(files.control, async () => {
        removeOwned(files.metadata, current => current?.instanceId === instanceId && current.workerId === workerId);
      });
    } finally {
      process.off('message', stopMessage);
      shutdown.cleanup();
      // A worker is an IPC child of the supervisor. Closing IPC lets a failed
      // startup or a graceful shutdown actually exit rather than linger idle.
      if (process.connected) process.disconnect();
    }
  }
  return 0;
}

export async function stopAccountDaemon({ stateDir = STATE_DIR, timeoutMs = 6_000 } = {}) {
  stateDir = resolve(stateDir);
  const files = paths(stateDir);
  let owner;
  await withStoreLock(files.control, async () => {
    owner = readDaemonJson(files.supervisor);
    if (owner?.instanceId) atomicPrivateJson(files.stop, { instanceId: owner.instanceId, requestedAt: Date.now() });
  });
  if (!owner) return { stopped: false, reason: 'not-running' };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && sameOwner(readDaemonJson(files.supervisor), owner) && ownedProcess(owner)) {
    await sleep(50);
  }
  if (sameOwner(readDaemonJson(files.supervisor), owner) && ownedProcess(owner)) {
    // A hung supervisor is signalled only with an OS birth-time match. A
    // recycled PID in a fresh-looking file must never receive this signal.
    if (owner.pid !== process.pid && owner.pidBirth && accountProcessBirth(owner.pid) === owner.pidBirth) {
      try { process.kill(owner.pid, 'SIGTERM'); } catch { /* raced with exit */ }
      await sleep(100);
    } else return { stopped: false, reason: 'stop-pending' };
  }
  await withStoreLock(files.control, async () => {
    if (ownedProcess(owner)) return;
    removeOwned(files.supervisor, current => sameOwner(current, owner));
    removeOwned(files.metadata, current => current?.instanceId === owner.instanceId);
    removeOwned(files.stop, current => current?.instanceId === owner.instanceId);
  });
  return { stopped: !sameOwner(readDaemonJson(files.supervisor), owner), supervisorPid: owner.pid };
}

export async function cmdAccountDaemon(args = [], options = {}) {
  const [command = 'ensure'] = args;
  const write = options.write ?? (message => console.log(message));
  if (command === 'ensure' || command === 'start') {
    const status = await ensureAccountDaemon(options);
    write(status.disabled ? 'Account routing is not configured.'
      : `Account daemon healthy at http://127.0.0.1:${status.port} (worker ${status.pid}, supervisor ${status.supervisorPid}).`);
    return 0;
  }
  if (command === 'status') {
    const status = await accountDaemonStatus(options);
    write(args.includes('--json') ? JSON.stringify(status)
      : status.healthy ? `Account daemon healthy at http://127.0.0.1:${status.port}.`
        : `Account daemon is not healthy (${status.reason}).`);
    return status.healthy ? 0 : 1;
  }
  if (command === 'stop') {
    const result = await stopAccountDaemon(options);
    write(result.stopped ? 'Account daemon stopped.' : `Account daemon: ${result.reason ?? 'stop-pending'}.`);
    return result.stopped || result.reason === 'not-running' ? 0 : 1;
  }
  throw new Error('Usage: unsnooze daemon ensure|start|status [--json]|stop');
}
