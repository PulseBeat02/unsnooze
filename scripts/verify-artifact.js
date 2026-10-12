// Build a fresh immutable package and verify every shipped byte against source.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { changelogSection } from './release-notes.mjs';

const output = resolve(process.argv[2]);
mkdirSync(output, { recursive: true, mode: 0o700 });
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 120_000 });
const [manifest] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', output]));
const archive = join(output, manifest.filename);
const bytes = readFileSync(archive);
assert.equal(manifest.integrity, `sha512-${createHash('sha512').update(bytes).digest('base64')}`);
assert.equal(manifest.shasum, createHash('sha1').update(bytes).digest('hex'));
const paths = run('tar', ['-tzf', archive]).trim().split('\n');
assert.equal(paths.length, manifest.files.length);
assert.equal(new Set(paths).size, paths.length);
for (const path of paths) {
  assert.match(path, /^package\/(?:bin\/|src\/|package\.json$|README\.md$|LICENSE$|CHANGELOG\.md$)/);
  assert.ok(!path.split('/').includes('..') && !path.includes('\\'), 'safe archive path');
  assert.doesNotMatch(path, /(?:^|\/)(?:\.env[^/]*|accounts\.json|router-token|credentials|tokens|node_modules|\.git)(?:\/|$)/);
}
run('tar', ['-xzf', archive, '-C', output]);
const packageDir = join(output, 'package');
for (const entry of manifest.files) {
  const data = readFileSync(join(packageDir, entry.path));
  assert.deepEqual(data, readFileSync(entry.path), `packaged source bytes: ${entry.path}`);
  assert.doesNotMatch(data.toString(), /(?:sk-ant-[A-Za-z0-9_-]{40,}|ya29\.[A-Za-z0-9_-]{60,})/);
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(run(process.execPath, [join(packageDir, 'bin/unsnooze.js'), '--version']).trim(), pkg.version);
assert.match(readFileSync(join(packageDir, 'LICENSE'), 'utf8'), /MIT License/);
assert.ok(changelogSection(readFileSync(join(packageDir, 'CHANGELOG.md'), 'utf8'), pkg.version),
  'the installed artifact needs release notes for its exact version');
for (const helper of ['unsnooze-ensure', 'unsnooze-update', 'unsnooze-shell.bash']) {
  run('bash', ['-n', join(packageDir, 'bin', helper)]);
}
run('git', ['diff', '--check']);
const result = { version: pkg.version, files: paths.length, archive, packageDir,
  sha256: createHash('sha256').update(bytes).digest('hex') };
writeFileSync(join(output, 'artifact.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(result));
