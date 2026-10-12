// Private local stores. Errors deliberately never contain paths, JSON input,
// or the native parser/OS message: these files can contain credentials.
import {
  constants, openSync, closeSync, fstatSync, lstatSync, readFileSync,
  writeFileSync, fsyncSync, fchmodSync, renameSync, unlinkSync, mkdirSync,
  readdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

export class PrivateStoreError extends Error {
  constructor(code) {
    super({
      PRIVATE_FILE: 'Account storage requires an owner-only regular file.',
      INVALID_JSON: 'Account storage contains invalid JSON.',
      STORE_READ: 'Account storage could not be read.',
      STORE_WRITE: 'Account storage could not be written.',
      LOCK_INVALID: 'Account storage lock is invalid.',
      LOCK_TIMEOUT: 'Account storage is busy; try again.',
    }[code] || 'Account storage failed.');
    this.name = 'PrivateStoreError';
    this.code = code;
  }
}

function privateStat(st) {
  return st.isFile() && st.nlink === 1 && (process.platform === 'win32'
    || ((st.mode & 0o077) === 0 && (typeof process.getuid !== 'function' || st.uid === process.getuid())));
}

// lstat + O_NOFOLLOW + fstat covers both links present at entry and paths
// swapped while opening. The inode comparison also protects platforms where
// O_NOFOLLOW is unavailable. O_NONBLOCK avoids hanging on an injected FIFO.
function openPrivate(path) {
  let fd;
  try {
    const before = lstatSync(path);
    if (!privateStat(before)) throw new PrivateStoreError('PRIVATE_FILE');
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const actual = fstatSync(fd);
    if (!privateStat(actual) || before.dev !== actual.dev || before.ino !== actual.ino) {
      throw new PrivateStoreError('PRIVATE_FILE');
    }
    return fd;
  } catch (err) {
    if (fd !== undefined) closeSync(fd);
    if (err instanceof PrivateStoreError) throw err;
    // Only the caller that requested a fallback may handle absence.
    if (err?.code === 'ENOENT') throw Object.assign(new PrivateStoreError('STORE_READ'), { missing: true });
    throw new PrivateStoreError('STORE_READ');
  }
}

export function assertPrivateFile(path) {
  const fd = openPrivate(path);
  closeSync(fd);
  return path;
}

export function readPrivateJson(path, fallback) {
  try {
    const raw = readPrivateText(path);
    try { return JSON.parse(raw); } catch { throw new PrivateStoreError('INVALID_JSON'); }
  } catch (err) {
    if (err?.missing && arguments.length >= 2) return fallback;
    throw err;
  }
}

export function readPrivateText(path) {
  const fd = openPrivate(path);
  try {
    return readFileSync(fd, 'utf8');
  } catch {
    throw new PrivateStoreError('STORE_READ');
  } finally {
    closeSync(fd);
  }
}

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (!st.isDirectory() || (process.platform !== 'win32' && typeof process.getuid === 'function' && st.uid !== process.getuid())) {
    throw new PrivateStoreError('PRIVATE_FILE');
  }
}

function syncDirectory(path) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY); fsyncSync(fd); }
  catch (err) {
    // Windows cannot open directories with fs.open; some filesystems cannot
    // fsync them. Other failures still mean durability was not established.
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(err?.code)
        && !(process.platform === 'win32' && ['EPERM', 'EACCES'].includes(err?.code))) throw err;
  } finally { if (fd !== undefined) closeSync(fd); }
}

function writeJson(path, value, durable) {
  const parent = dirname(path);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    const data = JSON.stringify(value, null, 2);
    if (data === undefined) throw new PrivateStoreError('STORE_WRITE');
    ensureDirectory(parent);
    // Never open or chmod the destination: replacing a link cannot write
    // through it. Exclusive unpredictable temporary paths cannot reuse a
    // predecessor's exposed inode.
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${data}\n`, 'utf8');
    if (durable) fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    if (durable) syncDirectory(parent);
    return path;
  } catch {
    throw new PrivateStoreError('STORE_WRITE');
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
    try { unlinkSync(temp); } catch { /* renamed or never created */ }
  }
}

export function atomicPrivateJson(path, value) {
  return writeJson(path, value, true);
}

function birthId(pid) {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const started = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      if (!/^\d+$/.test(started) || !boot) return null;
      return `${boot}:${started}`;
    }
    if (process.platform === 'win32') {
      return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`],
      { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim() || null;
    }
    return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='],
      { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { return null; }
}

const fingerprint = birth => birth === null ? 'unknown' : createHash('sha256').update(birth).digest('hex');
const CLAIM = /^(\d+)-(unknown|[a-f0-9]{64})-([a-f0-9-]{36})\.json$/;

function ownerAlive(pid, birth) {
  try { process.kill(pid, 0); }
  catch (err) { if (err?.code === 'ESRCH') return false; return true; }
  if (birth === 'unknown') return true;
  const actual = birthId(pid);
  // Failure to inspect a live process is not permission to steal its lock.
  return actual === null || fingerprint(actual) === birth;
}

function claimsIn(dir) {
  const claims = [];
  for (const name of readdirSync(dir)) {
    const m = CLAIM.exec(name);
    if (!m) {
      if (name.endsWith('.tmp')) continue; // unpublished atomic write
      throw new PrivateStoreError('LOCK_INVALID');
    }
    const pid = Number(m[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new PrivateStoreError('LOCK_INVALID');
    const path = join(dir, name);
    if (!ownerAlive(pid, m[2])) {
      // Nonce paths are never reused. Two reapers can unlink only this dead
      // claim, never a successor's lock (the usual check-then-unlink race).
      try { unlinkSync(path); } catch (err) { if (err?.code !== 'ENOENT') throw new PrivateStoreError('LOCK_INVALID'); }
      continue;
    }
    const claim = readPrivateJson(path, null);
    if (claim === null) continue; // owner finished while we were checking
    if (!claim || claim.pid !== pid || claim.birth !== m[2] || claim.nonce !== m[3]
        || !(claim.ticket === null || (Number.isSafeInteger(claim.ticket) && claim.ticket > 0))) {
      throw new PrivateStoreError('LOCK_INVALID');
    }
    claims.push({ ...claim, name });
  }
  return claims;
}

// Lamport's bakery lock with per-invocation claim files. Publishing a claim
// before choosing a ticket makes concurrent entrants wait; (ticket, nonce)
// breaks ties. No shared owner file is deleted or replaced during recovery.
// PID + process birth handles crashed writers and recycled PIDs; a live
// owner is never evicted because its work took a long time.
export async function withStoreLock(path, fn, { timeoutMs = 10_000, pollMs = 20 } = {}) {
  if (typeof fn !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs < 0
      || !Number.isFinite(pollMs) || pollMs <= 0) throw new PrivateStoreError('LOCK_INVALID');
  const dir = `${path}.lock`;
  const owner = { pid: process.pid, birth: fingerprint(birthId(process.pid)), nonce: randomUUID(), ticket: null };
  const name = `${owner.pid}-${owner.birth}-${owner.nonce}.json`;
  const claimPath = join(dir, name);
  const deadline = performance.now() + timeoutMs;
  try {
    ensureDirectory(dir);
    const stat = lstatSync(dir);
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new PrivateStoreError('LOCK_INVALID');
    // Claims need atomic visibility, not disk durability: after a machine
    // crash every claimant is dead. Committed store values still fsync both
    // their contents and parent directory through atomicPrivateJson.
    writeJson(claimPath, owner, false);
    const tickets = claimsIn(dir).map(c => c.ticket || 0);
    owner.ticket = Math.max(0, ...tickets) + 1;
    if (!Number.isSafeInteger(owner.ticket)) throw new PrivateStoreError('LOCK_INVALID');
    writeJson(claimPath, owner, false);
    for (;;) {
      const blocked = claimsIn(dir).some(c => c.name !== name && (c.ticket === null
        || c.ticket < owner.ticket || (c.ticket === owner.ticket && c.name < name)));
      if (!blocked) return await fn();
      if (performance.now() >= deadline) throw new PrivateStoreError('LOCK_TIMEOUT');
      await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - performance.now()))));
    }
  } catch (err) {
    if (err instanceof PrivateStoreError) throw err;
    // Preserve callback errors: they are the caller's own domain errors.
    // Only filesystem setup/inspection failures are translated below.
    if (err?.syscall) throw new PrivateStoreError('LOCK_INVALID');
    throw err;
  } finally {
    // The owner nonce is part of the path, so this cannot release any other
    // call's claim, including another call from this same process.
    try { unlinkSync(claimPath); } catch { /* already removed or not created */ }
  }
}
