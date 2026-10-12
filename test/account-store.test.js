import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, chmodSync,
  symlinkSync, linkSync, mkdirSync, readdirSync, utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import {
  readPrivateJson, readPrivateText, atomicPrivateJson, withStoreLock,
} from '../src/accounts/store.js';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-account-store-'));
const MODULE = new URL('../src/accounts/store.js', import.meta.url).href;
const posix = process.platform !== 'win32';
after(() => rmSync(DIR, { recursive: true, force: true }));
const file = name => join(DIR, name);

function child(code) {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  proc.stdout.on('data', b => { stdout += b; });
  proc.stderr.on('data', b => { stderr += b; });
  const ended = once(proc, 'exit').then(([code, signal]) => ({ code, signal, stdout, stderr }));
  return { proc, ended, output: () => stdout };
}

async function until(check, ms = 5_000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('Timed out waiting for fixture child.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('private JSON round trips; a missing store alone uses fallback', () => {
  const path = file('roundtrip.json');
  const fallback = {};
  assert.equal(readPrivateJson(path, fallback), fallback);
  atomicPrivateJson(path, { count: 1 });
  assert.deepEqual(readPrivateJson(path), { count: 1 });
  if (posix) assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readPrivateText(path), '{\n  "count": 1\n}\n');
  assert.throws(() => readPrivateJson(file('absent.json')), e => e.code === 'STORE_READ' && e.missing);
});

test('corrupt JSON reports a fixed error without bytes or native parser details', () => {
  const path = file('corrupt.json');
  writeFileSync(path, 'SUPRSECRET_invalid', { mode: 0o600 });
  assert.throws(() => readPrivateJson(path, {}), e => e.code === 'INVALID_JSON'
    && !e.message.includes('SUPRSECRET') && !e.message.includes('Unexpected token'));
  assert.equal(readFileSync(path, 'utf8'), 'SUPRSECRET_invalid');
});

test('private reads retry a legitimate atomic rename between lstat and open', async () => {
  const path = file('heartbeat.json'), replacement = file('heartbeat-next.json');
  atomicPrivateJson(path, { generation: 1 });
  atomicPrivateJson(replacement, { generation: 2 });
  const fixture = child(`import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    const original=fs.openSync;let opens=0;
    fs.openSync=(path,...args)=>{
      if(path===${JSON.stringify(path)} && ++opens===1)fs.renameSync(${JSON.stringify(replacement)},path);
      return original(path,...args);
    };
    syncBuiltinESMExports();
    const {readPrivateJson}=await import(${JSON.stringify(MODULE)});
    process.stdout.write(JSON.stringify({value:readPrivateJson(${JSON.stringify(path)}),opens}));`);
  const result = await fixture.ended;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { value: { generation: 2 }, opens: 2 });
});

test('private reads retry an inode unlinked by atomic rename after open', async () => {
  const path = file('opened-heartbeat.json'), replacement = file('opened-heartbeat-next.json');
  atomicPrivateJson(path, { generation: 1 });
  atomicPrivateJson(replacement, { generation: 2 });
  const fixture = child(`import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    const originalOpen=fs.openSync,originalStat=fs.fstatSync;let targetFd;let stats=0;
    fs.openSync=(path,...args)=>{
      const fd=originalOpen(path,...args);
      if(path===${JSON.stringify(path)})targetFd=fd;
      return fd;
    };
    fs.fstatSync=(fd,...args)=>{
      if(fd===targetFd && ++stats===1)fs.renameSync(${JSON.stringify(replacement)},${JSON.stringify(path)});
      return originalStat(fd,...args);
    };
    syncBuiltinESMExports();
    const {readPrivateJson}=await import(${JSON.stringify(MODULE)});
    process.stdout.write(JSON.stringify({value:readPrivateJson(${JSON.stringify(path)}),stats}));`);
  const result = await fixture.ended;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { value: { generation: 2 }, stats: 2 });
});

test('private open retries are bounded and never accept an injected symlink', { skip: !posix }, async () => {
  const path = file('changing.json'), source = file('link-source.json');
  atomicPrivateJson(path, {});
  atomicPrivateJson(source, {});
  const fixture = child(`import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    const original=fs.openSync;let opens=0;let attack=false;
    fs.openSync=(path,...args)=>{
      if(path===${JSON.stringify(path)}) {
        opens++;
        const next=path+'.replacement';
        if(attack)fs.symlinkSync(${JSON.stringify(source)},next);
        else fs.writeFileSync(next,'{}',{mode:0o600});
        fs.renameSync(next,path);
      }
      return original(path,...args);
    };
    syncBuiltinESMExports();
    const {readPrivateJson}=await import(${JSON.stringify(MODULE)});
    const codes=[];
    try{readPrivateJson(${JSON.stringify(path)})}catch(e){codes.push(e.code)}
    const boundedOpens=opens;
    attack=true;
    try{readPrivateJson(${JSON.stringify(path)})}catch(e){codes.push(e.code)}
    process.stdout.write(JSON.stringify({codes,boundedOpens,opens}));`);
  const result = await fixture.ended;
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.boundedOpens, 5);
  assert.equal(output.opens, 6);
  assert.deepEqual(output.codes, ['PRIVATE_FILE', 'STORE_READ']);
});

test('private reads reject exposed files, symlinks, hardlinks, and directories', { skip: !posix }, () => {
  const path = file('private.json');
  atomicPrivateJson(path, {});
  chmodSync(path, 0o644);
  assert.throws(() => readPrivateJson(path), { code: 'PRIVATE_FILE' });
  chmodSync(path, 0o600);
  const link = file('symlink.json');
  symlinkSync(path, link);
  assert.throws(() => readPrivateText(link), { code: 'PRIVATE_FILE' });
  const hardlink = file('hardlink.json');
  linkSync(path, hardlink);
  assert.throws(() => readPrivateJson(hardlink), { code: 'PRIVATE_FILE' });
  assert.throws(() => readPrivateJson(DIR), { code: 'PRIVATE_FILE' });
});

test('atomic replacement neither writes through links nor preserves exposed modes', { skip: !posix }, () => {
  const target = file('external.json'), path = file('replace-link.json');
  writeFileSync(target, 'untouched', { mode: 0o600 });
  symlinkSync(target, path);
  atomicPrivateJson(path, { fresh: true });
  assert.equal(readFileSync(target, 'utf8'), 'untouched');
  assert.deepEqual(readPrivateJson(path), { fresh: true });
  chmodSync(path, 0o644);
  atomicPrivateJson(path, { fresh: false });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readdirSync(DIR).filter(p => p.endsWith('.tmp')).length, 0);
});

test('failed serialization does not damage existing data or echo input', () => {
  const path = file('failed-write.json');
  atomicPrivateJson(path, { value: 1 });
  const value = {}; value.self = value;
  assert.throws(() => atomicPrivateJson(path, value), { code: 'STORE_WRITE' });
  assert.deepEqual(readPrivateJson(path), { value: 1 });
});

test('async callers in one process cannot overlap their critical sections', async () => {
  const path = file('in-process.json');
  let active = 0, max = 0, finished = 0;
  await Promise.all(Array.from({ length: 12 }, () => withStoreLock(path, async () => {
    active++;
    max = Math.max(max, active);
    await new Promise(resolve => setTimeout(resolve, 4));
    finished++;
    active--;
  })));
  assert.equal(max, 1);
  assert.equal(finished, 12);
  assert.deepEqual(readdirSync(`${path}.lock`), []);
});

test('independent writers preserve every update under contention', async () => {
  const path = file('race.json');
  atomicPrivateJson(path, { count: 0 });
  const script = `import {withStoreLock,readPrivateJson,atomicPrivateJson} from ${JSON.stringify(MODULE)};
    for(let i=0;i<8;i++) await withStoreLock(${JSON.stringify(path)},async()=>{
      const value=readPrivateJson(${JSON.stringify(path)});
      await new Promise(r=>setTimeout(r,3));
      value.count++;
      atomicPrivateJson(${JSON.stringify(path)},value);
    });`;
  const children = Array.from({ length: 5 }, () => child(script));
  try {
    for (const result of await Promise.all(children.map(c => c.ended))) assert.equal(result.code, 0, result.stderr);
    assert.equal(readPrivateJson(path).count, 40);
    assert.deepEqual(readdirSync(`${path}.lock`), []);
  } finally { for (const c of children) c.proc.kill(); }
});

test('old live locks are never stolen and a killed writer is recoverable', async () => {
  const path = file('killed.json');
  const holder = child(`import {withStoreLock} from ${JSON.stringify(MODULE)};
    await withStoreLock(${JSON.stringify(path)},async()=>{
      process.stdout.write('ready');
      await new Promise(r=>setTimeout(r,60000));
    });`);
  try {
    await until(() => holder.output().includes('ready'));
    for (const name of readdirSync(`${path}.lock`)) utimesSync(join(`${path}.lock`, name), 1, 1);
    utimesSync(`${path}.lock`, 1, 1);
    let entered = false;
    await assert.rejects(withStoreLock(path, async () => { entered = true; }, { timeoutMs: 80, pollMs: 10 }), { code: 'LOCK_TIMEOUT' });
    assert.equal(entered, false);
    assert.equal(readdirSync(`${path}.lock`).length, 1, 'timed out contender must remove only its own claim');
    holder.proc.kill('SIGKILL');
    await holder.ended;
    await withStoreLock(path, async () => { entered = true; }, { timeoutMs: 500 });
    assert.equal(entered, true);
    assert.deepEqual(readdirSync(`${path}.lock`), []);
  } finally { holder.proc.kill('SIGKILL'); }
});

test('Linux process birth mismatch recovers a recycled PID without waiting for age', { skip: process.platform !== 'linux' }, async () => {
  const path = file('birth.json');
  mkdirSync(`${path}.lock`, { mode: 0o700 });
  const nonce = '12345678-1234-1234-1234-123456789012';
  const birth = createHash('sha256').update('different-boot-and-birth').digest('hex');
  const claim = join(`${path}.lock`, `${process.pid}-${birth}-${nonce}.json`);
  atomicPrivateJson(claim, { pid: process.pid, birth, nonce, ticket: 1 });
  let entered = false;
  await withStoreLock(path, async () => { entered = true; }, { timeoutMs: 200 });
  assert.equal(entered, true);
  assert.deepEqual(readdirSync(`${path}.lock`), []);
});

test('Linux zombie owner is recoverable before its parent reaps the PID', { skip: process.platform !== 'linux' }, async () => {
  const path = file('zombie.json');
  mkdirSync(`${path}.lock`, { mode: 0o700 });
  const pid = 2_123_456_789;
  const nonce = '12345678-1234-1234-1234-123456789012';
  atomicPrivateJson(join(`${path}.lock`, `${pid}-unknown-${nonce}.json`), { pid, birth: 'unknown', nonce, ticket: 1 });
  const fixture = child(`import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    const originalRead=fs.readFileSync,originalKill=process.kill;
    process.kill=(pid,signal)=>pid===${pid} && signal===0 ? true : originalKill(pid,signal);
    fs.readFileSync=(path,...args)=>path===${JSON.stringify(`/proc/${pid}/stat`)}
      ? '${pid} (unreaped lock owner) Z 0 0 0' : originalRead(path,...args);
    syncBuiltinESMExports();
    const {withStoreLock}=await import(${JSON.stringify(MODULE)});
    let entered=false;
    await withStoreLock(${JSON.stringify(path)},async()=>{entered=true},{timeoutMs:100,pollMs:10});
    process.stdout.write(JSON.stringify({entered}));`);
  const result = await fixture.ended;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { entered: true });
  assert.deepEqual(readdirSync(`${path}.lock`), []);
});

test('unreadable live process state is not authority to steal its lock', { skip: process.platform !== 'linux' }, async () => {
  const path = file('unreadable-owner.json');
  mkdirSync(`${path}.lock`, { mode: 0o700 });
  const pid = 2_123_456_788;
  const nonce = '12345678-1234-1234-1234-123456789012';
  const birth = createHash('sha256').update('unreadable birth').digest('hex');
  const claim = `${pid}-${birth}-${nonce}.json`;
  atomicPrivateJson(join(`${path}.lock`, claim), { pid, birth, nonce, ticket: 1 });
  const fixture = child(`import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    const originalRead=fs.readFileSync,originalKill=process.kill;
    process.kill=(pid,signal)=>pid===${pid} && signal===0 ? true : originalKill(pid,signal);
    fs.readFileSync=(path,...args)=>{
      if(path===${JSON.stringify(`/proc/${pid}/stat`)})throw Object.assign(new Error('unreadable'),{code:'EACCES'});
      return originalRead(path,...args);
    };
    syncBuiltinESMExports();
    const {withStoreLock}=await import(${JSON.stringify(MODULE)});
    let code;
    try {await withStoreLock(${JSON.stringify(path)},async()=>{throw new Error('must not enter')},{timeoutMs:100,pollMs:10});}
    catch(e){code=e.code}
    process.stdout.write(JSON.stringify({code}));`);
  const result = await fixture.ended;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { code: 'LOCK_TIMEOUT' });
  assert.deepEqual(readdirSync(`${path}.lock`), [claim]);
});

test('a corrupt live owner claim fails closed and is not erased', async () => {
  const path = file('bad-lock.json');
  mkdirSync(`${path}.lock`, { mode: 0o700 });
  const claim = join(`${path}.lock`, `${process.pid}-unknown-12345678-1234-1234-1234-123456789012.json`);
  writeFileSync(claim, 'SUPRSECRET_invalid', { mode: 0o600 });
  await assert.rejects(withStoreLock(path, async () => assert.fail('must not enter')), e => e.code === 'INVALID_JSON' && !e.message.includes('SUPRSECRET'));
  assert.equal(readFileSync(claim, 'utf8'), 'SUPRSECRET_invalid');
});

test('a callback failure releases its claim for the next writer', async () => {
  const path = file('throws.json');
  const error = new Error('test callback');
  await assert.rejects(withStoreLock(path, async () => { throw error; }), e => e === error);
  assert.equal(await withStoreLock(path, async () => 42), 42);
  assert.deepEqual(readdirSync(`${path}.lock`), []);
});
