<div align="center">

<img src="assets/banner.svg" alt="unsnooze — wakes every limit-stopped AI session the moment the limit resets" width="880"/>

<br/>

[![CI](https://github.com/saaranshM/unsnooze/actions/workflows/ci.yml/badge.svg)](https://github.com/saaranshM/unsnooze/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/unsnooze?color=f59e0b)](https://www.npmjs.com/package/unsnooze)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2020.12-3fb950)](package.json)
[![license](https://img.shields.io/badge/license-MIT-8b949e)](LICENSE)

**Automatically resume every limit-stopped AI coding session when its usage limit resets.**

[Website](https://unsnooze.dev) · [Documentation](https://unsnooze.dev/docs/) · [Changelog](https://unsnooze.dev/changelog/) · [Feedback](https://unsnooze.dev/feedback/)

**Claude Code · Codex CLI · Grok · Qwen · Kimi · OpenCode · Antigravity · Cursor** — when they hit the 5-hour or weekly usage limit
("You've hit your usage limit"), your session just… stops.<br/>
unsnooze auto-resumes them: it tracks **every** limit-stopped session across all
your projects and **wakes each one up the moment the usage limit resets** — in
tmux, Zellij, herdr or cmux, and on **macOS, Linux and Windows**, with or
without a terminal multiplexer.

```sh
npm install -g git+https://github.com/PulseBeat02/unsnooze.git && unsnooze setup
```

<img src="assets/demo.svg" alt="terminal demo: limit banners detected in two sessions, unsnooze waits for the reset, then wakes both — good morning, the work is done" width="880"/>

</div>

## PulseBeat02 account-management fork

This fork adds configurable Claude, Codex and Antigravity accounts, measured
provider usage, and a supervised local router. Upstream history and the MIT
license are retained. Install this fork from its checkout, **not the upstream
npm release**:

```sh
git clone git@github.com:PulseBeat02/unsnooze.git
cd unsnooze
npm ci && npm test && npm run lint
npm pack
npm install -g ./unsnooze-1.20.1-pulse.4.tgz
unsnooze accounts import all
unsnooze accounts list --json
unsnooze usage --json --refresh
unsnooze daemon ensure
```

`~/.unsnooze/accounts.json` contains account names, enabled flags, priority,
credential file references and a policy for each provider. Files holding
credentials and account state must be owner-only (`0600`); credentials are
never printed by these commands. Existing claude-rotate, codex-multi-auth and
Antigravity imports reference their files and do not refresh or copy their
tokens. Disable old refresh owners before transferring a Codex credential to
unsnooze's managed store; two independent clients must never share a refresh
token. The managed store durably records refresh intent before exchanging a
single-use token. An uncertain exchange requires login instead of unsafe reuse.

```sh
unsnooze accounts add claude Work --path /private/work.token
unsnooze accounts disable claude Work
unsnooze accounts enable claude Work
unsnooze accounts switch claude Work
unsnooze accounts pin claude Work
unsnooze accounts unpin claude
unsnooze accounts policy codex --threshold-percent 95 --strategy headroom
unsnooze accounts policy codex --on-limit true --cooldown-ms 60000 --never-switch false
```

Selection prefers fresh measured headroom, then priority and configured order.
A threshold starts a switch when a better account is available; it does not
discard remaining quota. Pins and `neverSwitch` keep the selected account.
Expired login, unknown usage and network errors stay distinct from exhaustion.
Quota reset times never establish that an account has recovered: a successful
live check is required before clearing a local block or waking a managed session.

`unsnooze usage --json` adds a `providers` map with per-account `status`,
`fetchedAt`, `stale` and windows containing exact **used** percentages and epoch
millisecond reset times. Window names follow the provider; a Pro Lite primary
window can be weekly. The existing Usage dashboard displays these observations.
Exit code 2 signals the configured high-usage warning threshold; the JSON is
still valid. Inspect each account's status and freshness when checking health.
Claude uses its OAuth usage endpoint where authorized, or headers captured from
real requests. `unsnooze usage --json --probe` explicitly permits a one-token
Claude header probe. Routing can make that probe on demand when no fresh
observation exists; background polling alone never burns model tokens.
Antigravity uses `loadCodeAssist` followed by `retrieveUserQuotaSummary`, with
its native token and the required `User-Agent: antigravity`. An expired native
token needs Antigravity itself to refresh it; no OAuth client secret is extracted.

Claude and Codex route through an authenticated loopback server, changing
credentials only between requests. Full request payloads and conversation IDs
are preserved. Rejected requests may switch accounts; partially delivered
streams are never replayed. Incremental `previous_response_id` chains use durable
account affinity. A managed CLI restarts its exact saved conversation when the
chain needs another account; an unmanaged API client receives `session_resume_required`.
Codex uses HTTP streaming; the managed configuration disables WebSockets.
Antigravity uses serialized native credential handoff and `--conversation <id>`
at an observed limit stop, or after the policy threshold when its owned pane has
a stable empty composer and a known conversation. A draft, busy session or
ambiguous history delays threshold handoff. Its native CLI is the only refresh owner. Concurrent
native Antigravity launches cannot safely own the same credential slot; an
additional launch waits for the slot and fails safely if it remains busy.

The wrappers start routing when absent. `unsnooze daemon ensure` is idempotent
and succeeds only after an authenticated health check. A supervisor restarts
the router and existing transcript watcher/resumer, with PID birth identities,
heartbeats, bounded backoff and crash-safe state. `unsnooze daemon status`
inspects it; `unsnooze daemon stop` stops it. The default loopback port is 18484
(`UNSNOOZE_ROUTER_PORT` overrides it). No cron script is required for internal
recovery. An optional host heartbeat can run `unsnooze daemon ensure` after a
whole-process or host restart. Notifications and registry updates default off.

`bin/unsnooze-update` pulls only the owner's `origin/main` with fast-forward
history, runs a clean dependency install, tests and lint, then installs globally
only after those checks pass. A dirty checkout or unexpected remote stops it.

`bin/unsnooze-shell.bash` is an optional Bash migration block. Source it after
older wrappers when performing a backed-up cutover. It preserves native
`claude -c` and `agy -c`, maps a **bare** `codex -c` to `codex resume --last`,
and leaves valued Codex configuration flags intact.

The repeatable Linux acceptance workflow is separate from the unit suite:

```sh
node scripts/verify-artifact.js /private/verification/artifact
node scripts/verify-e2e.js /private/verification/artifact/artifact.json /private/verification/e2e
# A clean commit, fish on PATH, an existing progress directory, and a NEW run directory:
node scripts/verify-five.js /private/verification/five-passes /private/progress
```

Each of the five sequential passes runs the entire unfiltered `npm test` suite
(four test files at a time), lint, a fresh reproducible package check, and the
isolated acceptance workflow. A failure stops the sequence without retrying.
Every pass records its commit, test counts and artifact hash. Fish must be
available; the two real Windows legacy-daemon cases remain platform skips on
Linux. The uninstall-before-start race runs on all platforms.

Acceptance checks install into a disposable npm prefix, use synthetic accounts
and local provider endpoints, and exercise actual CLI commands, routing,
same-session native restarts, parked-session recovery, daemon crashes and
staged shell/package rollback. Native provider programs are fixtures; the host
handshake is simulated. The updater's external git/npm boundaries are stubbed
to prove that failed tests or lint cannot install. This verifies deployment
mechanics without certifying a production cutover. No real credentials or
installed user programs are changed. Set `TMPDIR` and `npm_config_cache` to
private work directories when operating under a maintenance write boundary.

## Why unsnooze

Overnight and long-running agent work dies at the 5-hour / weekly limit, and every
existing tool solves only a slice of it:

| | **unsnooze** | claude-auto-retry | autoclaude | hydra |
|---|:---:|:---:|:---:|:---:|
| Multi-CLI (Claude · Codex · Grok · Qwen · Kimi · OpenCode · Antigravity · Cursor) | ✅ | ❌ Claude only | ❌ Claude only | partial |
| GUI sessions (VS Code ext, desktop apps) | ✅ watcher daemon | ❌ | ❌ | ❌ |
| Waits for reset & resumes the **same** session | ✅ | ✅ | ✅ | ❌ switches provider |
| All sessions at once (shared ledger + one daemon) | ✅ | ❌ one pane | ✅ | ✅ |
| Revives sessions whose pane/process is **gone** | ✅ `--resume <id>` | ❌ | ❌ | ❌ |
| Survives laptop sleep & weekly-scale waits | ✅ epoch polling | partial | partial | n/a |
| Settings + first-run wizard | ✅ | ❌ | ❌ | ❌ |

## Quick start

```sh
npm install -g git+https://github.com/PulseBeat02/unsnooze.git
unsnooze setup      # pick agents; installs shell wrappers + the Claude hook
```

Then use `claude`, `codex` and the rest exactly as before — the wrappers run them
in a watched pane. When one hits its limit, unsnooze records the stop and wakes it
the moment the limit resets.

```sh
unsnooze status               # tracked sessions + reset countdowns (live dashboard on a TTY)
unsnooze preview [id]         # dry-run: what would be typed, where, and why — sends nothing
unsnooze resume-now [id|--all]
unsnooze usage                # burn rate and time-to-limit, before you hit the wall
unsnooze doctor [--fix]       # install health check
```

Needs Node ≥ 20.12 on macOS, Linux or Windows. tmux ≥ 3.2, Zellij, herdr ≥ 0.8
or cmux give pane-level watching; without one, unsnooze runs headless and still
catches and resumes stops. Every command: [command reference](https://unsnooze.dev/docs/commands/).

## Supported agents

| Agent | Detection | Revival |
|---|---|---|
| **Claude Code** | `StopFailure` hook + pane + transcripts; answers the limit menu safely | `claude --resume <id>` |
| **Codex CLI** / ChatGPT app | pane banner + rollout files (exact reset time) | `codex resume <id>` |
| Grok Build *(experimental)* | hook + pane | `grok --resume <id>` |
| Qwen Code *(experimental)* | hook + pane | `qwen --resume <id>` |
| Kimi CLI *(experimental)* | pane | `kimi -r <id>` |
| OpenCode *(experimental)* | pane (it retries by itself; unsnooze revives it if it dies) | `opencode -s <id>` |
| Antigravity `agy` *(experimental)* | pane | `agy --conversation=<id>` |
| Cursor `cursor-agent` *(experimental)* | pane; billing-cycle limit, so it probes instead of scheduling | `cursor-agent --resume=<id>` |

GUI sessions (Claude Code's VS Code extension, the ChatGPT/Codex desktop app,
Claude desktop) are watched through the files they already write, by the optional
daemon. Per-agent details, OpenRouter, proxy launchers like Headroom, and Claude
Design: [supported agents](https://unsnooze.dev/docs/agents/).

## How it works

<div align="center">
<img src="assets/how-it-works.png" alt="architecture: claude/codex/grok panes are watched by unsnooze via hooks and banner scraping; stops land in state.json; the resumer daemon sleeps until the limit resets, then types into live panes or reopens dead ones until every session is running again" width="880"/>
</div>

Stops are detected from agent hooks, saved session files and terminal banners,
and recorded in `~/.unsnooze/state.json` with the reset time. A single daemon
checks the clock every 30 seconds — so a laptop that slept through the reset still
wakes on time — then types your resume message into the live pane, or reopens the
session by id if its pane is gone. Every wake is verified; if the limit is still
there it reschedules, up to 5 attempts.

## Trust & security

unsnooze is a **scheduler that presses your keys — not an auto-approver.**

- **Types only after proving the pane is yours** — an ownership stamp or process
  lease, plus your agent running and idle there. Unprovable → it opens a fresh
  session instead of typing.
- **Never presses a menu option blind**, and never selects "Upgrade your plan".
- **No `--dangerously-skip-permissions`, no auto-trust, no auto-approve.** What
  your agent does after the wake is governed by its own permission model.
- **No telemetry.** One daily version check to npm (`updateCheck=false` turns it
  off) and ntfy push only if you set it up. State stays in `~/.unsnooze`.
- **Reversible.** Every file it edits is backed up; `unsnooze uninstall` removes
  every change. Releases are published with npm provenance.
- **Fleet (multi-machine) uses your own SSH** — no ports, no tokens, no weakened
  host-key checking.

It does inject keystrokes into your terminal, and it does not sandbox your agent.
Full threat model and vulnerability reporting: **[SECURITY.md](SECURITY.md)**.

## FAQ

**What does "You've hit your usage limit" mean?** Claude and ChatGPT plans meter
usage in a rolling 5-hour window plus a weekly cap. When either runs out, the
agent stops mid-task. Nothing is lost — the session can be resumed after the
reset, and unsnooze does that for every stopped session automatically.

**Does this get around the rate limit?** No. It waits for the reset exactly like
you would, resumes once, and checks the limit actually lifted. It replaces the
4am alarm, not the limit.

**Can it start my 5-hour window before I sit down?** Yes, experimentally:
`unsnooze config set primeAt.claude auto` learns when you usually start and has
the daemon send one tiny Haiku prompt 3 hours earlier, so the window resets
mid-session instead of 5 hours in. A fixed time like `06:00` works too. Claude
and Codex only. See [window priming](https://unsnooze.dev/docs/commands/#prime).

More questions and troubleshooting: [unsnooze.dev/docs/troubleshooting](https://unsnooze.dev/docs/troubleshooting/).

## Documentation

- [Install & setup](https://unsnooze.dev/docs/) — terminals, multiplexers, Windows and WSL
- [Supported agents](https://unsnooze.dev/docs/agents/)
- [Commands](https://unsnooze.dev/docs/commands/) — usage forecast, queued prompts
- [Settings & guards](https://unsnooze.dev/docs/settings/) — every config key, notifications
- [Fleet](https://unsnooze.dev/docs/fleet/) — sessions on every machine over SSH, GUI surfaces
- [Troubleshooting & security](https://unsnooze.dev/docs/troubleshooting/) — including development setup
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
