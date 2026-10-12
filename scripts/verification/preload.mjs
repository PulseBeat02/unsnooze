// Test-only transport substitution. This file is never shipped. Real provider
// URLs can only reach the loopback fixture; an unexpected network call fails.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const root = process.env.UNSNOOZE_E2E_ROOT;
const endpoint = process.env.UNSNOOZE_E2E_ENDPOINT;
if (!root || resolve(homedir()) !== resolve(root, 'home')
  || !existsSync(join(root, 'ISOLATED-VERIFICATION'))
  || !/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint ?? '')) {
  throw new Error('The verification transport requires an isolated fixture.');
}
const realFetch = globalThis.fetch;
const providers = new Set(['api.anthropic.com', 'chatgpt.com', 'daily-cloudcode-pa.googleapis.com', 'auth.openai.com']);
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  // Ink/Yoga loads its embedded WebAssembly via a data URL, with no network.
  if (url.protocol === 'data:') return realFetch(input, init);
  if (url.hostname === '127.0.0.1' && url.protocol === 'http:') return realFetch(input, init);
  if (url.protocol !== 'https:' || !providers.has(url.hostname)) {
    throw new Error('Verification blocked a non-fixture destination.');
  }
  return realFetch(`${endpoint}/${url.hostname}${url.pathname}${url.search}`, init);
};
