// Account host: the credential-holding half of unsnooze, run by a service
// manager (systemd) instead of the detached supervisor. It routes requests,
// refreshes managed Codex logins and answers usage/selection for remote-mode
// clients. It never starts the session monitor; that stays with the sessions.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { STATE_DIR } from '../config.js';
import { readRemoteConfig } from './remote.js';

const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

// sd_listen_fds(3): descriptors start at 3 and belong to us only when
// LISTEN_PID names this process. Names come from FileDescriptorName=.
export function systemdListeners(env = process.env, pid = process.pid) {
  const count = Number(env.LISTEN_FDS);
  if (!Number.isInteger(count) || count < 1 || Number(env.LISTEN_PID) !== pid) return [];
  const names = (env.LISTEN_FDNAMES || '').split(':');
  return Array.from({ length: count }, (_, i) => ({ fd: 3 + i, name: names[i] || `fd${3 + i}` }));
}

// Trusted listeners are Unix sockets whose directory is the access control
// (the devbox link). Everything else requires the router token.
export function hostListeners(env = process.env, pid = process.pid) {
  const trustedNames = new Set((env.UNSNOOZE_HOST_TRUSTED_LISTENERS ?? 'devbox').split(',').map(s => s.trim()).filter(Boolean));
  const activated = systemdListeners(env, pid);
  if (activated.length) return activated.map(l => ({ fd: l.fd, name: l.name, trusted: trustedNames.has(l.name) }));
  const listeners = [];
  if (env.UNSNOOZE_HOST_SOCKET) listeners.push({ path: env.UNSNOOZE_HOST_SOCKET, name: 'devbox', trusted: true });
  if (env.UNSNOOZE_ROUTER_PORT) listeners.push({ host: '127.0.0.1', port: Number(env.UNSNOOZE_ROUTER_PORT), name: 'host', trusted: false });
  return listeners;
}

export async function runHostRouter({
  stateDir = STATE_DIR, env = process.env, signal, startProxy, log = message => console.error(message),
} = {}) {
  stateDir = resolve(stateDir);
  if (readRemoteConfig(stateDir)) throw new Error('This state directory is in remote mode; an account host must hold its own logins.');
  const listeners = hostListeners(env);
  if (!listeners.length) throw new Error('No listener: use systemd socket activation, UNSNOOZE_HOST_SOCKET or UNSNOOZE_ROUTER_PORT.');
  if (!startProxy) ({ startAccountProxy: startProxy } = await import('./proxy.js'));
  const startedAt = Date.now();
  const proxy = await startProxy({ stateDir, listeners, api: true,
    health: () => ({ service: 'unsnooze-accounts-host', version: VERSION, startedAt }) });
  log(`unsnooze account host ${VERSION} listening (${listeners.map(l => `${l.name}${l.trusted ? ' trusted' : ''}`).join(', ')})`);
  await new Promise(done => {
    const stop = () => {
      signal?.removeEventListener('abort', stop);
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
      done();
    };
    if (signal?.aborted) return stop();
    signal?.addEventListener('abort', stop, { once: true });
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
  await proxy.close();
  log('unsnooze account host stopped');
  return 0;
}
