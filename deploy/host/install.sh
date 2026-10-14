#!/bin/bash
# Install the unsnooze account host on the host WITHOUT enabling or starting anything (run as root).
#   deploy/host/install.sh [<checkout>]     default checkout: the host-daemon worktree in the devbox home
# Installs: system user unsnooze-host (sysusers), the app from `npm pack` of the checkout into
# /usr/local/lib/unsnooze-host/app (never ~/.npm-global), the vault script, /var/lib/unsnooze-vault (root 0700),
# the devbox socket directory (uid 2000, 0700) and the units in /etc/systemd/system (daemon-reload only).
# Cutover steps: docs/host-daemon.md.
set -euo pipefail
SRC=${1:-/srv/media-b/apps/devbox/home/projects/WebstormProjects/unsnooze-host-daemon}
HERE=$SRC/deploy/host
PREFIX=/usr/local/lib/unsnooze-host
NODE=/usr/local/bin/node
NPM=/usr/local/bin/npm
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[ -x "$NODE" ] && [ -x "$NPM" ] || { echo "host Node 22 is expected at /usr/local/bin" >&2; exit 1; }
for f in unsnooze-host.service unsnooze-host-devbox.socket unsnooze-host-local.socket unsnooze-host-vault \
         unsnooze-host-vault-save.path unsnooze-host-vault-save.service unsnooze-host-vault-save.timer sysusers-unsnooze-host.conf; do
  [ -f "$HERE/$f" ] || { echo "missing $HERE/$f" >&2; exit 1; }
done

install -m 644 "$HERE/sysusers-unsnooze-host.conf" /etc/sysusers.d/unsnooze-host.conf
systemd-sysusers /etc/sysusers.d/unsnooze-host.conf

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
# Pack from a copy owned by root so npm never writes into the devbox checkout.
git -C "$SRC" -c safe.directory='*' archive --format=tar HEAD | tar -x -C "$work"
(cd "$work" && "$NPM" pack --silent --pack-destination "$work" >/dev/null)
install -d -m 755 "$PREFIX" "$PREFIX/app.new"
"$NPM" install --prefix "$PREFIX/app.new" --omit=dev --no-audit --no-fund --no-save "$work"/unsnooze-*.tgz >/dev/null
"$NODE" "$PREFIX/app.new/node_modules/unsnooze/bin/unsnooze.js" --version
[ -d "$PREFIX/app" ] && mv -T "$PREFIX/app" "$PREFIX/app.old-$(date -u +%Y%m%d-%H%M%S)"
mv -T "$PREFIX/app.new" "$PREFIX/app"
install -m 755 "$HERE/unsnooze-host-vault" "$PREFIX/unsnooze-host-vault"

install -d -m 700 /var/lib/unsnooze-vault
install -d -o 2000 -g 2000 -m 700 /srv/media-b/apps/devbox/home/.unsnooze-host

for u in unsnooze-host.service unsnooze-host-devbox.socket unsnooze-host-local.socket \
         unsnooze-host-vault-save.path unsnooze-host-vault-save.service unsnooze-host-vault-save.timer; do
  install -m 644 "$HERE/$u" "/etc/systemd/system/$u"
done
systemctl daemon-reload
echo "installed; nothing enabled or started. Next: docs/host-daemon.md, cutover step 2."
