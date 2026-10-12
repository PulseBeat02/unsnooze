import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import {
  ensureAccountDaemon, stopAccountDaemon, accountDaemonStatus, accountProcessBirth,
  requestAccountHealth, cmdAccountDaemon,
} from '../src/accounts/daemon.js';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-account-daemon-'));
const FIXTURE = join(DIR, 'fixture.mjs');
const MODULE = new URL('../src/accounts/daemon.js', import.meta.url).href;
const childArgs = process.execArgv.filter(arg => !arg.startsWith('--test'));
const children = [];
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const configured = () => ({ providers: { claude: { accounts: [{ id: 'test', enabled: true }] } } });

// No real proxy, credentials, provider requests, watchers, or user config are
// loaded in this fixture. It exercises the actual supervisor over real IPC,
// process exits, private files and an authenticated loopback HTTP endpoint.
writeFileSync(FIXTURE, `
import { runAccountSupervisor, runAccountWorker } from ${JSON.stringify(MODULE)};
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const stateDir = process.env.UNSNOOZE_STATE_DIR;
const port = Number(process.env.UNSNOOZE_ROUTER_PORT);
const role = process.argv[2];
const start = (role, extra = {}) => spawn(process.execPath, [...process.execArgv, ${JSON.stringify(FIXTURE)}, role], {
  env: { ...process.env, ...extra }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
if (role === 'legacy') {
  writeFileSync(join(stateDir, 'legacy.json'), JSON.stringify({pid:process.pid}), {mode:0o600});
  process.on('disconnect', () => process.exit(0));
  process.on('message', m => { if (m?.type === 'unsnooze-stop') process.exit(0); });
} else if (role === 'supervisor') {
  await runAccountSupervisor({ stateDir, port, heartbeatMs:40, restartBaseMs:40, restartMaxMs:120,
    healthGraceMs:300, healthCheckMs:60,
    spawnWorker: opts => start('worker', { UNSNOOZE_ACCOUNT_INSTANCE:opts.instanceId,
      UNSNOOZE_ACCOUNT_WORKER:opts.workerId, UNSNOOZE_ACCOUNT_SUPERVISOR_PID:String(opts.supervisorPid) }),
  });
} else {
  await runAccountWorker({ stateDir, port, heartbeatMs:40, reconcileMs:100,
    reconcile:async()=>{}, hasVersionSkew:()=>false,
    startLegacy:()=>start('legacy'),
    startProxy:async({port,health})=>{
      const tokenPath = join(stateDir, 'router-token');
      if (!existsSync(tokenPath)) writeFileSync(tokenPath, 'test-local-token', {mode:0o600});
      const server = createServer((req,res)=>{
        if (req.headers.authorization !== 'Bearer ' + readFileSync(tokenPath,'utf8')) {
          res.writeHead(401); res.end(); return;
        }
        const corrupted = existsSync(join(stateDir,'bad-health'));
        res.setHeader('Content-Type','application/json');
        res.end(JSON.stringify({ok:true,service:'unsnooze-accounts',pid:process.pid,
          ...health(), ...(corrupted ? {workerId:'wrong-generation'} : {})}));
      });
      await new Promise((resolve,reject)=>{server.once('error',reject); server.listen(port,'127.0.0.1',resolve);});
      return {port,close:()=>new Promise(resolve=>server.close(resolve))};
    },
  });
}
`, { mode: 0o600 });

after(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await sleep(100);
  rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function fixtureSpawner(count) {
  return ({ stateDir, port, instanceId }) => {
    count.value++;
    const child = spawn(process.execPath, [...childArgs, FIXTURE, 'supervisor'], {
      env: { ...process.env, UNSNOOZE_STATE_DIR: stateDir, UNSNOOZE_ROUTER_PORT: String(port),
        UNSNOOZE_ACCOUNT_INSTANCE: instanceId, UNSNOOZE_CLAUDE_DIR: join(DIR, 'empty-claude'),
        UNSNOOZE_CODEX_DIR: join(DIR, 'empty-codex'), UNSNOOZE_UPDATE_CHECK: '0', UNSNOOZE_NOTIFICATIONS: 'off' },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    children.push(child);
    return child;
  };
}

async function until(check, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await check();
    if (result) return result;
    await sleep(25);
  } while (Date.now() < deadline);
  assert.fail('condition did not become true');
}

test('no accounts leaves the legacy daemon untouched', async () => {
  const stateDir = join(DIR, 'unused');
  const result = await ensureAccountDaemon({ stateDir, readAccounts: () => ({ providers: {} }),
    spawnSupervisor: () => { assert.fail('must not spawn'); } });
  assert.equal(result.disabled, true);
  assert.equal(existsSync(stateDir), false);
});

test('concurrent ensure is one healthy supervisor, and healthy ensure exits zero', async t => {
  const stateDir = join(DIR, 'concurrent');
  const port = await freePort();
  const count = { value: 0 };
  const options = { stateDir, port, readAccounts: configured, spawnSupervisor: fixtureSpawner(count) };
  t.after(() => stopAccountDaemon({ stateDir }));
  const statuses = await Promise.all(Array.from({ length: 8 }, () => ensureAccountDaemon(options)));
  assert.equal(count.value, 1);
  assert.equal(new Set(statuses.map(s => s.pid)).size, 1);
  assert.equal(new Set(statuses.map(s => s.supervisorPid)).size, 1);
  assert.equal(await cmdAccountDaemon(['ensure'], { ...options, write: () => {} }), 0);
  assert.equal(count.value, 1);
  assert.equal(await requestAccountHealth({ port, token: 'incorrect' }), null);
  if (process.platform !== 'win32') {
    for (const name of ['account-daemon.json', 'account-supervisor.json', 'router-token']) {
      assert.equal(statSync(join(stateDir, name)).mode & 0o077, 0);
    }
  }
});

test('supervisor replaces a killed worker at the same port and worker restarts its watcher', async t => {
  const stateDir = join(DIR, 'restart');
  const port = await freePort();
  const options = { stateDir, port, readAccounts: configured, spawnSupervisor: fixtureSpawner({ value: 0 }) };
  t.after(() => stopAccountDaemon({ stateDir }));
  const first = await ensureAccountDaemon(options);
  const initialLegacy = await until(() => {
    try { return read(join(stateDir, 'legacy.json')).pid; } catch { return null; }
  });
  process.kill(initialLegacy, 'SIGKILL');
  const restartedLegacy = await until(() => {
    const pid = read(join(stateDir, 'legacy.json')).pid;
    return pid !== initialLegacy && pid;
  });
  assert.notEqual(restartedLegacy, initialLegacy);
  process.kill(first.pid, 'SIGKILL');
  const second = await until(async () => {
    const status = await accountDaemonStatus({ stateDir });
    return status.healthy && status.pid !== first.pid && status;
  });
  assert.equal(second.port, first.port);
  assert.equal(second.supervisorPid, first.supervisorPid);
  assert.equal(second.metadata.instanceId, first.metadata.instanceId);
  assert.notEqual(second.metadata.workerId, first.metadata.workerId);
  assert.equal(readFileSync(join(stateDir, 'router-token'), 'utf8'), 'test-local-token');
});

test('corrupt metadata recovers and forged health identity cannot look healthy', async t => {
  const stateDir = join(DIR, 'corrupt');
  const port = await freePort();
  const count = { value: 0 };
  const options = { stateDir, port, readAccounts: configured, spawnSupervisor: fixtureSpawner(count) };
  t.after(() => stopAccountDaemon({ stateDir }));
  const first = await ensureAccountDaemon(options);
  writeFileSync(join(stateDir, 'account-daemon.json'), '{truncated', { mode: 0o600 });
  const recovered = await ensureAccountDaemon(options);
  assert.equal(recovered.supervisorPid, first.supervisorPid);
  assert.equal(count.value, 1);
  const forged = await accountDaemonStatus({ stateDir, healthRequest: async () => ({
    ok: true, service: 'unsnooze-accounts', pid: recovered.pid, supervisorPid: recovered.supervisorPid,
    instanceId: recovered.metadata.instanceId, workerId: 'unrelated',
  }) });
  assert.equal(forged.healthy, false);
  const before = read(join(stateDir, 'account-supervisor.json'));
  writeFileSync(join(stateDir, 'account-supervisor.json'), '{truncated', { mode: 0o600 });
  const replacement = await ensureAccountDaemon(options);
  assert.equal(replacement.healthy, true);
  // A heartbeat may repair the disposable file before ensure observes it.
  // Both retaining the verified owner and replacing a lost owner are valid.
  assert.ok(replacement.supervisorPid === before.pid || count.value === 2);
});

test('stop removes daemon ownership and a stale recycled PID is never signalled', async () => {
  const stateDir = join(DIR, 'stop');
  const port = await freePort();
  await ensureAccountDaemon({ stateDir, port, readAccounts: configured, spawnSupervisor: fixtureSpawner({ value: 0 }) });
  assert.equal((await stopAccountDaemon({ stateDir })).stopped, true);
  assert.equal((await accountDaemonStatus({ stateDir })).healthy, false);
  assert.equal(existsSync(join(stateDir, 'account-supervisor.json')), false);
  assert.equal(existsSync(join(stateDir, 'account-daemon.json')), false);
  writeFileSync(join(stateDir, 'account-supervisor.json'), JSON.stringify({
    pid: process.pid, pidBirth: `${accountProcessBirth(process.pid)}-not-this-process`,
    instanceId: 'stale', heartbeatAt: Date.now(),
  }), { mode: 0o600 });
  assert.equal((await stopAccountDaemon({ stateDir })).stopped, true);
  assert.equal(existsSync(join(stateDir, 'account-supervisor.json')), false);
});

test('birth identity uses creation time on Linux, macOS and Windows', () => {
  const tail = Array(20).fill('0'); tail[19] = '123';
  assert.equal(accountProcessBirth(42, { platform: 'linux',
    readFile: file => file.endsWith('/stat') ? '42 (process name) ' + tail.join(' ') : 'boot-id\n',
  }), 'boot-id:123');
  for (const platform of ['darwin', 'win32']) {
    let called = false;
    assert.equal(accountProcessBirth(42, { platform, execFile: (_file, args) => {
      called = true; assert.match(args.join(' '), /42/); return 'birth-time\n';
    } }), 'birth-time');
    assert.equal(called, true);
  }
  assert.equal(accountProcessBirth(0), null);
});

test('fresh heartbeat and OS birth identity are both required before trusting health', async () => {
  const stateDir = mkdtempSync(join(DIR, 'identity-'));
  const now = Date.now();
  const owner = { instanceId: 'instance', pid: process.pid, pidBirth: accountProcessBirth(process.pid), heartbeatAt: now };
  const worker = { ...owner, workerId: 'worker', supervisorPid: process.pid, port: 18484 };
  const write = (name, value) => writeFileSync(join(stateDir, name), JSON.stringify(value), { mode: 0o600 });
  write('account-supervisor.json', owner);
  write('account-daemon.json', worker);
  writeFileSync(join(stateDir, 'router-token'), 'fixture-token', { mode: 0o600 });
  let requested = 0;
  const options = { stateDir, now, healthRequest: async () => {
    requested++; return { ok: true, service: 'unsnooze-accounts', ...worker };
  } };
  assert.equal((await accountDaemonStatus(options)).healthy, true);
  write('account-daemon.json', { ...worker, heartbeatAt: now - 60_000 });
  assert.equal((await accountDaemonStatus(options)).healthy, false);
  write('account-daemon.json', { ...worker, pidBirth: 'recycled-process' });
  assert.equal((await accountDaemonStatus(options)).healthy, false);
  write('account-daemon.json', worker);
  write('account-supervisor.json', { ...owner, heartbeatAt: now - 60_000 });
  assert.equal((await accountDaemonStatus(options)).healthy, false);
  assert.equal(requested, 1);
});

test('health timeout is a total deadline even when a listener keeps sending data', async () => {
  const server = createServer(socket => {
    socket.on('error', () => {});
    socket.write('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n');
    const interval = setInterval(() => socket.write('1\r\n \r\n'), 10);
    socket.on('close', () => clearInterval(interval));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const start = Date.now();
    assert.equal(await requestAccountHealth({ port: server.address().port, token: 'fixture', timeoutMs: 80 }), null);
    assert.ok(Date.now() - start < 1_000);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
