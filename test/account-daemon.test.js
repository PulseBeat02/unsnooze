import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { emptyAccounts, saveAccounts, readAccounts } from '../src/accounts/config.js';
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

// No real credentials, provider requests, watchers, or user config are used in
// this fixture. It exercises the actual supervisor over real IPC,
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
    healthGraceMs:2000, healthCheckMs:60,
    spawnWorker: opts => start('worker', { UNSNOOZE_ACCOUNT_INSTANCE:opts.instanceId,
      UNSNOOZE_ACCOUNT_WORKER:opts.workerId, UNSNOOZE_ACCOUNT_SUPERVISOR_PID:String(opts.supervisorPid) }),
  });
} else {
  await runAccountWorker({ stateDir, port, heartbeatMs:40, reconcileMs:100,
    reconcile:async()=>{}, hasVersionSkew:()=>false,
    startLegacy:()=>start('legacy'),
    startProxy:async({port,health})=>{
      if (existsSync(join(stateDir, 'routing-fixture'))) {
        const { startAccountProxy } = await import(${JSON.stringify(new URL('../src/accounts/proxy.js', import.meta.url).href)});
        const { selectRoutingAccount } = await import(${JSON.stringify(new URL('../src/accounts/routing.js', import.meta.url).href)});
        const { atomicPrivateJson } = await import(${JSON.stringify(new URL('../src/accounts/store.js', import.meta.url).href)});
        return startAccountProxy({ stateDir, port, health,
          selectFn:(provider,opts)=>selectRoutingAccount(provider,{...opts,usageFn:async()=>({
            providers:{codex:{accounts:['a','b'].map(id=>({id,status:id==='a'&&existsSync(join(stateDir,'a-rejected'))?'quota_exhausted':'ok',
              fetchedAt:Date.now(),stale:false,windows:[{id:'5h',usedPercent:id==='a'&&existsSync(join(stateDir,'a-rejected'))?100:0}]}))}},
          })}),
          credentialFn:async(_provider,account)=>{
            if(account.id==='b'&&!existsSync(join(stateDir,'switch-committed.json'))) {
              atomicPrivateJson(join(stateDir,'switch-committed.json'),{accountId:account.id});
              await new Promise(()=>{}); // killed after commit but before forwarding
            }
            return {accessToken:account.id};
          },
          usageHeadersFn:async()=>{},
          fetchFn:async(_url,opts)=>{
            if(opts.headers.get('authorization')==='Bearer a') {
              writeFileSync(join(stateDir,'a-rejected'),'1',{mode:0o600});
              return new Response('{"error":{"type":"usage_limit_reached"}}',{status:429});
            }
            atomicPrivateJson(join(stateDir,'forwarded.json'),{
              accountId:'b',sessionId:opts.headers.get('session_id'),body:opts.body.toString(),
            });
            return new Response('resumed-same-conversation');
          },
        });
      }
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

test('daemon killed after a quota switch commit recovers the chosen account and exact conversation', async t => {
  const stateDir = join(DIR, 'killed-mid-switch'), port = await freePort();
  const config = emptyAccounts();
  config.providers.codex.accounts = ['a', 'b'].map(id => ({ id, name: id, enabled: true, priority: 0,
    credential: { type: 'managed', path: join(stateDir, `${id}.json`) } }));
  config.providers.codex.activeAccountId = 'a';
  saveAccounts(config, stateDir);
  writeFileSync(join(stateDir, 'routing-fixture'), '1', { mode: 0o600 });
  const options = { stateDir, port, spawnSupervisor: fixtureSpawner({ value: 0 }) };
  t.after(() => stopAccountDaemon({ stateDir }));
  const first = await ensureAccountDaemon(options);
  const body = JSON.stringify({ model: 'gpt-test', input: [{ role: 'user', content: 'fixture conversation' }] });
  const request = () => fetch(`http://127.0.0.1:${port}/codex/responses`, { method: 'POST',
    headers: { authorization: `Bearer ${readFileSync(join(stateDir, 'router-token'), 'utf8')}`,
      session_id: 'durable-session' }, body, signal: AbortSignal.timeout(20000) });
  const interrupted = request().then(r => r.text()).catch(() => 'disconnected');
  await until(() => existsSync(join(stateDir, 'switch-committed.json')), 12000);
  assert.equal(readAccounts(stateDir).providers.codex.activeAccountId, 'b');
  assert.equal(existsSync(join(stateDir, 'forwarded.json')), false);
  process.kill(first.pid, 'SIGKILL');
  assert.equal(await interrupted, 'disconnected');
  const recovered = await until(async () => {
    const status = await accountDaemonStatus({ stateDir });
    return status.healthy && status.pid !== first.pid && status;
  }, 12000);
  assert.equal(recovered.supervisorPid, first.supervisorPid);
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'resumed-same-conversation');
  assert.deepEqual(read(join(stateDir, 'forwarded.json')), { accountId: 'b', sessionId: 'durable-session', body });
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
