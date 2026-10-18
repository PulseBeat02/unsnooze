#!/bin/bash
# Copy the devbox's Claude and Codex logins into the host vault and write the host account config (run as root).
# Cutover step 3 in docs/host-daemon.md. Does not touch the devbox daemon, its files or any session.
#  - Claude: the setup token file (static, never refreshed by unsnooze): copied.
#  - Codex: the managed login. Refresh tokens rotate, so exactly one side may refresh it. This refuses unless the
#    access token is valid for at least MIN_HOURS more (default 24): until it nears expiry nobody refreshes, so the
#    copy stays valid while the devbox is switched to remote mode (step 5), after which only the host refreshes.
#  - agy: stays in the devbox (its CLI owns and refreshes the native token; see the design doc).
#  - affinity/: session-to-account claims, so chained Codex requests keep their account after the switch.
# Prints names and hours only, never credential contents.
set -euo pipefail
DEVHOME=/srv/data/apps/devbox/home
SRC=$DEVHOME/.unsnooze
STATE=/var/lib/unsnooze
VAULT_CMD=/usr/local/lib/unsnooze-host/unsnooze-host-vault
MIN_HOURS=${MIN_HOURS:-24}
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
getent passwd unsnooze-host >/dev/null || { echo "run install.sh first" >&2; exit 1; }
install -d -o unsnooze-host -g unsnooze-host -m 700 "$STATE" "$STATE/affinity"

python3 -I - "$SRC/accounts.json" "$DEVHOME" "$MIN_HOURS" > /run/unsnooze-host-import.plan <<'PY'
import json, sys, time, os
accounts, devhome, min_hours = sys.argv[1], sys.argv[2], float(sys.argv[3])
cfg = json.load(open(accounts))
for provider in ("claude", "codex"):
    for a in cfg["providers"].get(provider, {}).get("accounts", []):
        ref = a["credential"]
        if ref["type"] not in ("claude-token", "managed"):
            sys.exit(f"{provider} account {a['id']}: credential type {ref['type']} cannot be moved; import it as managed first")
        path = ref["path"]
        if not path.startswith("/home/dev/"):
            sys.exit(f"{provider} account {a['id']}: credential is outside /home/dev")
        host_path = os.path.join(devhome, path[len("/home/dev/"):])
        if provider == "codex":
            expires = json.load(open(host_path)).get("expiresAt")
            hours = (expires / 1000 - time.time()) / 3600 if expires else 0
            if hours < min_hours:
                sys.exit(f"codex account {a['id']}: access token valid {hours:.1f} h < {min_hours} h; refresh it in the devbox first")
            print(f"# codex {a['id']} valid for {hours:.0f} h", file=sys.stderr)
        print(provider, a["id"], os.path.basename(path), host_path)
PY
while read -r provider id name path; do
  "$VAULT_CMD" import "$name" "$path"
  stat -c "%n %Y %s" "$path" >> /var/lib/unsnooze-vault/import-stamps
done < /run/unsnooze-host-import.plan

python3 -I - "$SRC/accounts.json" "$STATE/accounts.json.new" <<'PY'
import json, sys, os
src, dest = sys.argv[1], sys.argv[2]
cfg = json.load(open(src))
out = {"version": 1, "providers": {}}
for provider in ("claude", "codex"):
    section = cfg["providers"].get(provider)
    if not section:
        continue
    section = dict(section)
    section["accounts"] = [dict(a, credential={"type": a["credential"]["type"],
                           "path": "/run/unsnooze-host/credentials/" + os.path.basename(a["credential"]["path"])})
                           for a in section["accounts"]]
    out["providers"][provider] = section
fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump(out, f, indent=2)
PY
chown unsnooze-host:unsnooze-host "$STATE/accounts.json.new"
mv -f "$STATE/accounts.json.new" "$STATE/accounts.json"

n=0
for f in "$SRC"/affinity/*.json; do
  [ -f "$f" ] || continue
  install -o unsnooze-host -g unsnooze-host -m 600 "$f" "$STATE/affinity/$(basename "$f")"; n=$((n+1))
done
rm -f /run/unsnooze-host-import.plan
echo "host accounts.json written; $n affinity records copied"
"$VAULT_CMD" status
