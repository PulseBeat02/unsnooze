# unsnooze account host

Status: built and tested on branch `host-daemon` (1.20.1-pulse.6), not deployed. Nothing on the server
uses it until the cutover below is run.

## Goal

No real AI-agent login inside any container. The Claude and Codex logins live on the host, encrypted at
rest, inside a hardened service. The devbox keeps working exactly as now (`127.0.0.1:18484`, the same local
router token, the same tmux monitoring and auto-resume), and host root Claude can route through the same
accounts.

## How unsnooze works today (pulse.5)

| Part | Where | What it touches |
|---|---|---|
| `accounts.json` | `~/.unsnooze` | account ids, names, policy, active/pinned, and a *reference* (type + path) per login |
| Claude login | `credentials/claude-*.token` | `claude setup-token` (1 year). Read on every request; unsnooze never refreshes it |
| Codex login | `credentials/codex-*.json` (`managed`) | read on every request; refreshed by `refresh.js` when < 30 s from expiry: writes a `refreshPending` intent, exchanges the refresh token at auth.openai.com, writes the rotated pair atomically. **Only one process may ever refresh it** (refresh tokens rotate) |
| agy login | native `~/.gemini/antigravity-cli/antigravity-oauth-token` | the agy CLI owns and refreshes it. unsnooze reads it for quota and, for multi-account switching, copies it to/from `credentials/agy-*.json` around a launch (`agy.js`). agy traffic is **not** proxied: the CLI talks to Google directly |
| Router | worker process, `127.0.0.1:18484` | `/claude/v1/messages`, `/count_tokens`, `/models`; `/codex/responses`, `/models`, ... and `/health`. Clients authenticate with `router-token` (Claude: `CLAUDE_CODE_OAUTH_TOKEN`; Codex: `env_key UNSNOOZE_ROUTER_TOKEN`). The router swaps in the provider token |
| Supervisor / worker | `account-supervisor.json`, `account-daemon.json`, control lock | detached supervisor restarts the worker; the worker exits on version skew (checked every 15 min) and the supervisor starts the new code |
| Session monitor | legacy `unsnooze daemon`, spawned by the worker | tmux capture/send-keys, leases, `state.json`, resumers. Wakes are gated by `accountResumeGate` -> `selectRoutingAccount` (usage + routing state); `reconcile` every 30 s uses `fetchUsageSnapshot` |
| Conversation handoff | `affinity/`, `resume-requests/<launch>.json` | the router records which account a session uses; a chained request for another account gets 409 and a resume request that the launcher (`runRoutedConversation`) polls |

There is no other CLI-daemon channel: files under `~/.unsnooze` plus HTTP on the router port.

## Design

```
devbox (no provider logins)                          host
--------------------------------                     ------------------------------------------------
claude / codex / Paseo / lab relay                   unsnooze-host.service  (user unsnooze-host)
   | Bearer <local router-token>                       node .../unsnooze.js _host-router
   v                                                   state  /var/lib/unsnooze (accounts.json, usage,
127.0.0.1:18484  unsnooze worker (remote mode)                routing state, affinity; no secrets)
   |  forwards /claude/ /codex/, drops the token       logins /run/unsnooze-host/credentials (RAM)
   |  asks host for usage + selection                         <- /var/lib/unsnooze-vault/*.cred
   v                                                          (systemd-creds, host key)
~/.unsnooze-host/router.sock  ==== Unix socket =====> listener "devbox" (trusted: dir is uid 2000, 0700)
monitor / mux / resumer / reconcile stay here          listener "host" 127.0.0.1:18486 (router token)
                                                          ^
                                                     host root Claude (claude-host-env.sh)
```

### Host side (`_host-router`)

- The same router code with `api: true` and listeners passed by systemd (`FileDescriptorName=devbox|host`).
  No supervisor (systemd restarts it), no session monitor, no reconciliation.
- It refuses to start on a state directory that is itself in remote mode.
- Account API, on both listeners. It never returns a credential, credential path or token:

  | Route | Use |
  |---|---|
  | `GET /health` | `service: unsnooze-accounts-host`, version |
  | `GET /accounts/v1/accounts` | ids, names, enabled, priority, policy, active, pinned |
  | `GET /accounts/v1/usage?refresh=1&probe=1` | the sanitized usage snapshot |
  | `POST /accounts/v1/select` | `{provider, reason, exclude, refresh, minFetchedAt, model}` -> chosen account metadata, reason, retryAt, status (strictly validated) |

- Codex refresh, usage-header capture, quota failover and affinity all happen here, unchanged.
- Account management (add, pin, disable, policy) is done on the host:
  `runuser -u unsnooze-host -- env UNSNOOZE_STATE_DIR=/var/lib/unsnooze /usr/local/bin/node /usr/local/lib/unsnooze-host/app/node_modules/unsnooze/bin/unsnooze.js accounts list`.

### Encryption at rest

- `/var/lib/unsnooze-vault/<name>.cred`: `systemd-creds encrypt --with-key=host` (the key host-secrets uses).
- `ExecStartPre=+unsnooze-host-vault unlock` decrypts into `/run/unsnooze-host/credentials` (tmpfs, owner
  `unsnooze-host`, 0600). A RAM copy already present is kept: after a crash restart it may be newer.
- Every rewrite is re-encrypted at once (`unsnooze-host-vault-save.path` watches the directory: a Codex
  refresh renames a new file into it), plus an hourly timer and `ExecStopPost`. Losing a rotated Codex
  refresh token would mean a new login, hence the immediate save.
- Restore = `/var/lib/unsnooze-vault` + `/var/lib/systemd/credential.secret` (same as host-secrets).

### Devbox side (remote mode)

- `unsnooze accounts remote enable --socket ~/.unsnooze-host/router.sock` checks the host's `/health`,
  keeps the local references once in `accounts.pre-remote.json`, writes `accounts-remote.json`, then
  mirrors the host's account metadata into `accounts.json` with references of type `remote` (path = the
  socket). `readCredential` refuses that type, so no local code can reach for a login.
- The worker keeps `127.0.0.1:18484` and the existing `router-token`. That token is the "dummy": it only
  opens the local forwarder, carries no provider access and is worthless outside the devbox. The env files
  (`claude-rotate.env`, `codex-rotate.env`), Paseo's agents and the lab relay need no change.
- Per request the worker reads `accounts-remote.json`: remote providers are forwarded over the socket with
  the local token removed (the launch header is kept so the host can keep affinity). A host 409
  `session_resume_required` becomes the local resume request, so account switches still resume the same
  conversation. Host down -> 502 to the client.
- `selectRoutingAccount` and `fetchUsageSnapshot` ask the host for remote providers; an unreachable host
  reads as `network_error`, which holds sessions and never wakes one. The worker refreshes the mirror
  before each 30 s reconciliation.
- Removing `accounts-remote.json` switches back to local routing on the next request, no restart.
- Local account commands refuse to change a remote provider.

### Claude, Codex and agy credential files in the devbox

| Agent | After cutover |
|---|---|
| Claude | routed sessions run on `CLAUDE_CODE_OAUTH_TOKEN` = the local router token; `~/.claude/.credentials.json` is not used by them and nothing in unsnooze reads it. Delete it once every live Claude has the env var (check below). A `claude` started without the env would then ask for login instead of silently using a real token |
| Codex | already dummy: `env_key UNSNOOZE_ROUTER_TOKEN`; `~/.codex/auth.json` is already gone |
| agy | **cannot run on dummy credentials.** The agy CLI (Go binary) calls `daily-cloudcode-pa.googleapis.com` itself with its native OAuth token and refreshes it itself; unsnooze has no agy proxy. Phase 1 keeps agy local: its native token stays in the devbox, the host cron `agy models` keeps it fresh, and the devbox measures agy usage itself (agy is never a remote provider). Phase 2 options: an agy endpoint override if Google adds one; or a host HTTPS relay with a devbox-trusted CA that swaps the token (fragile, intercepts TLS; not recommended) |

### Host root Claude

Source `deploy/host/claude-host-env.sh` from the host's claude launcher: `ANTHROPIC_BASE_URL=http://127.0.0.1:18486/claude`,
`CLAUDE_CODE_OAUTH_TOKEN=$(cat /var/lib/unsnooze/router-token)`. Then `/root/.claude/.credentials.json` can go
into the vault (or be deleted). Test in a separate shell first: claude.ai-backed features (connectors such as
Claude Docs, usage display) need the claude.ai login and may not work on a router token.

## Files (`deploy/host/`)

| File | Purpose |
|---|---|
| `unsnooze-host.service` | the service: user `unsnooze-host`, `ProtectSystem=strict`, `ProtectHome`, no capabilities, `@system-service` syscalls, 512 MB. `MemoryDenyWriteExecute` stays off (Node JIT) |
| `unsnooze-host-devbox.socket` | `/srv/media-b/apps/devbox/home/.unsnooze-host/router.sock`, name `devbox` |
| `unsnooze-host-local.socket` | `127.0.0.1:18486`, name `host` |
| `unsnooze-host-vault` | unlock / save / import / export / status (never prints contents) |
| `unsnooze-host-vault-save.{path,service,timer}` | save on change, hourly backstop |
| `sysusers-unsnooze-host.conf` | the system user |
| `install.sh` | installs all of the above from `npm pack` of the checkout into `/usr/local/lib/unsnooze-host/app`; enables nothing |
| `import-from-devbox.sh` | copies the Claude and Codex logins into the vault, writes the host `accounts.json`, copies `affinity/` |
| `claude-host-env.sh` | host root Claude routing |

## Cutover (live sessions keep working)

1. **Install the new version in the devbox** (merge `host-daemon` to `main`, push; the nightly
   `~/bin/unsnooze-update` or a manual run tests and installs it). The worker sees the version change within
   15 min and restarts on the new code: the router on 18484 is down for about a second. Remote mode is off,
   so behaviour is unchanged. Do this in a quiet moment (no live streaming request) or accept one retried
   request.
2. **Install on the host** (anytime): `deploy/host/install.sh`. Nothing enabled.
3. **Import the logins** (anytime, devbox untouched): `deploy/host/import-from-devbox.sh`. It refuses if the
   Codex access token has < 24 h left, so neither side refreshes during the switch.
4. **Start the host** (no effect on the devbox yet):
   `systemctl enable --now unsnooze-host-devbox.socket unsnooze-host-local.socket unsnooze-host-vault-save.path unsnooze-host-vault-save.timer`
   then check: `curl -s --unix-socket /srv/media-b/apps/devbox/home/.unsnooze-host/router.sock http://x/health`,
   `.../accounts/v1/usage?refresh=1` (both accounts `ok`), and one real request with the host token:
   `curl -s -H "authorization: Bearer $(cat /var/lib/unsnooze/router-token)" http://127.0.0.1:18486/claude/v1/models`.
5. **Switch the devbox** (hot, no restart, sessions keep their env):
   `docker exec devbox su - dev -c 'unsnooze accounts remote enable --socket ~/.unsnooze-host/router.sock && unsnooze accounts remote status'`.
   The next request of every live session goes through the host.
6. **Verify** for a while: `unsnooze usage` in the devbox, `journalctl -u unsnooze-host`, a short
   `claude -p` and `codex exec` in the devbox, the sweep still progressing, the Codex file stamp unchanged
   (`stat` vs `/var/lib/unsnooze-vault/import-stamps`: the devbox must not have refreshed after step 3).
7. **Remove the devbox logins** (only after 6): `~/.unsnooze/credentials/claude-*.token`,
   `~/.unsnooze/credentials/codex-*.json`, `~/.claude/.credentials.json` (first check every live claude has
   `CLAUDE_CODE_OAUTH_TOKEN`: `for p in $(pgrep -u dev -x claude); do tr '\0' '\n' </proc/$p/environ | grep -c '^CLAUDE_CODE_OAUTH_TOKEN='; done`).
   Keep `accounts.pre-remote.json` (paths only) for rollback.
8. **Host root Claude** (when the owner is not mid-session): source `claude-host-env.sh` in the host launcher,
   start a new host Claude, then move `/root/.claude/.credentials.json` into the vault or delete it.

## Rollback

- Before step 7: `unsnooze accounts remote disable` in the devbox restores the local references; routing is
  local on the next request. Stop the host service afterwards so only one side holds the Codex login.
- After step 7: first `systemctl stop unsnooze-host.service` (stops host refreshes), then
  `unsnooze-host-vault export <name> /srv/media-b/apps/devbox/home/.unsnooze/credentials/<name>` and
  `chown 2000:2000` for the Claude and Codex files, then `unsnooze accounts remote disable`.
- Copy `/var/lib/unsnooze/affinity/*.json` back to the devbox if chained Codex sessions must keep their account.

## Risks

- **Two Codex refreshers** = a revoked login. Avoided by the 24 h check in step 3, the switch in step 5 and
  stopping the host before any rollback. Never run the host and a local-mode devbox on the same Codex login.
- Host down = every devbox agent gets 502 / sessions are held (systemd `Restart=always`; the socket stays
  bound while the service restarts, so requests queue instead of failing).
- Step 1 restarts the devbox router once (about a second); a streaming request at that moment fails and is
  retried by the client.
- The devbox can still spend quota through the socket (as today through 18484); it cannot read a login.
- The lab relay keeps using the devbox router token and port: unchanged, and it still never sees a login.
- agy stays a secret in the devbox until a Phase 2 exists.
- Host root Claude on a router token may lose claude.ai-only features; test before switching.

## Tests

`test/account-remote.test.js`: trusted socket vs token listener, API without credentials, input validation,
forwarding (local token checked and dropped, provider token only on the host, launch header not sent
upstream), hot switch back by deleting the file, 409 -> local resume request, host outage (502, held
selection, `network_error` usage), enable/disable round trip with agy kept local, CLI guards, systemd fd
parsing, and the real `_host-router` lifecycle.
