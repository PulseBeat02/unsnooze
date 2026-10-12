// Dependency-free source hygiene and syntax gate for the shipped Node program.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory()
    ? walk(join(dir, e.name)) : /\.[cm]?js$/.test(e.name) ? [join(dir, e.name)] : []);
}
let failed = false;
for (const file of [...walk('src'), ...walk('bin'), ...walk('scripts')]) {
  const syntax = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (syntax.status !== 0) { console.error(syntax.stderr); failed = true; }
  if (file.startsWith('src/accounts/')) {
    const text = readFileSync(file, 'utf8');
    if (/\s+$/m.test(text.split('\n').filter(x => /[ \t]+$/.test(x)).join('\n'))) {
      console.error(`${file}: trailing whitespace`); failed = true;
    }
    if (/\b(?:eval|new Function)\s*\(/.test(text)) {
      console.error(`${file}: dynamic code execution`); failed = true;
    }
  }
}
if (failed) process.exitCode = 1;
else console.log('Syntax and source hygiene clean.');
