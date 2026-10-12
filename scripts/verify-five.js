// Five uninterrupted acceptance passes on one clean commit. A failure stops
// immediately; it is never hidden by retrying a command or resuming at pass 2.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readFileSync, appendFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { once } from 'node:events';

const output = resolve(process.argv[2]);
const progressDir = resolve(process.argv[3]);
mkdirSync(output, { recursive: false, mode: 0o700 });
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const commit = git('rev-parse', 'HEAD');
const clean = () => { assert.equal(git('rev-parse', 'HEAD'), commit); assert.equal(git('status', '--porcelain'), ''); };
clean();
assert.equal(process.platform, 'linux', 'this acceptance profile verifies Linux plus documented Windows skips');
const fish = execFileSync('fish', ['--version'], { encoding: 'utf8' }).trim();
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^(UNSNOOZE_|ANTHROPIC|CLAUDE|CODEX|AGY|GEMINI|GOOGLE|OPENAI|TMUX|ZELLIJ|HERDR|CMUX|NODE_OPTIONS)/.test(name)));
env.UNSNOOZE_UPDATE_CHECK = '0'; env.UNSNOOZE_NOTIFICATIONS = 'off';
const testFiles = (dir => {
  const visit = p => readdirSync(p, { withFileTypes: true }).flatMap(e => e.isDirectory()
    ? visit(join(p, e.name)) : /\.test\.[cm]?js$/.test(e.name) ? [join(p, e.name)] : []);
  return visit(dir);
})('test');
const record = line => {
  const dated = `${new Date().toISOString()} ${line.replace(/\s+/g, ' ').trim()}`;
  appendFileSync(join(progressDir, 'progress.md'), dated + '\n');
  appendFileSync(join(progressDir, 'REPORT.md'), dated + '\n\n');
  console.log(dated);
};
async function phase(name, file, args, directory) {
  clean();
  const log = join(directory, `${name}.log`), fd = openSync(log, 'wx', 0o600);
  console.log(`${new Date().toISOString()} ${dirname(directory).split('/').at(-1)}/${directory.split('/').at(-1)} ${name} started`);
  try {
    const child = spawn(file, args, { env, stdio: ['ignore', fd, fd] });
    const [code, signal] = await once(child, 'close');
    assert.equal(code, 0, `${name} failed (signal ${signal}); see ${log}`);
  } finally { closeSync(fd); }
  clean();
  return readFileSync(log, 'utf8');
}
const passes = [];
let artifactHash = null;
try {
  for (let number = 1; number <= 5; number++) {
    const directory = join(output, `pass-${number}`);
    mkdirSync(directory, { mode: 0o700 });
    const home = join(directory, 'home'); mkdirSync(home, { mode: 0o700 });
    env.HOME = home;
    const startedAt = new Date().toISOString();
    const log = await phase('unit', 'npm', ['test'], directory);
    const count = name => Number([...log.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))].at(-1)?.[1]);
    const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(name => [name, count(name)]));
    assert.ok(counts.tests >= 1615, 'the whole unfiltered suite must run');
    assert.equal(counts.fail + counts.cancelled + counts.todo, 0);
    assert.equal(counts.skipped, 2);
    assert.equal(counts.tests, counts.pass + counts.skipped);
    const skips = log.split('\n').filter(line => /# SKIP/.test(line));
    assert.equal(skips.length, 2);
    assert.ok(skips.some(line => line.includes('a second `unsnooze daemon` stands down')));
    assert.ok(skips.some(line => line.includes('the StopFailure hook starts the daemon')));
    assert.ok(skips.every(line => line.includes('only on native Windows')));
    await phase('lint', 'npm', ['run', 'lint'], directory);
    await phase('artifact', process.execPath, ['scripts/verify-artifact.js', join(directory, 'artifact')], directory);
    const artifactFile = join(directory, 'artifact/artifact.json');
    const artifact = JSON.parse(readFileSync(artifactFile, 'utf8'));
    artifactHash ??= artifact.sha256;
    assert.equal(artifact.sha256, artifactHash, 'every pass must reproduce the same artifact');
    await phase('e2e', process.execPath, ['scripts/verify-e2e.js', artifactFile, join(directory, 'e2e')], directory);
    const e2e = JSON.parse(readFileSync(join(directory, 'e2e/e2e.json'), 'utf8'));
    assert.equal(e2e.failures.length, 0); assert.equal(e2e.passed, 19);
    const result = { number, commit, startedAt, completedAt: new Date().toISOString(), counts,
      testFiles: testFiles.length, fish, skips, artifact, e2eChecks: e2e.passed, lint: 'green', directory };
    passes.push(result);
    writeFileSync(join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    writeFileSync(join(output, 'results.json'), JSON.stringify({ commit, passed: passes.length, passes }, null, 2) + '\n', { mode: 0o600 });
    record(`Verification pass ${number}/5 GREEN on ${commit}: full npm test (${testFiles.length} test files), ${counts.tests} tests, ${counts.pass} passed, ${counts.skipped} native-Windows-only skips, 0 failures/cancellations; lint green; ${artifact.files} artifact files, SHA-256 ${artifact.sha256}; ${e2e.passed} isolated E2E checks green. Evidence: ${directory}.`);
  }
} catch (error) {
  record(`Verification sequence FAILED on ${commit} after ${passes.length} consecutive green passes; count reset to 0. ${error.message}`);
  writeFileSync(join(output, 'FAILED.json'), JSON.stringify({ commit, completed: passes.length, consecutive: 0, message: error.message }, null, 2) + '\n', { mode: 0o600 });
  process.exitCode = 1;
}
