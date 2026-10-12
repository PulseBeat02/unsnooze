# Source after any older shell definitions during the owner's reversible cutover.
# The native executable still handles informational invocations and recursion.
unalias claude codex agy 2>/dev/null || true
claude() {
  if [ "${UNSNOOZE_ACTIVE:-}" = 1 ]; then command claude "$@"; else command unsnooze _run claude "$@"; fi
}
codex() {
  if [ "$#" -eq 1 ] && [ "$1" = -c ]; then set -- resume --last; fi
  if [ "${UNSNOOZE_ACTIVE:-}" = 1 ]; then command codex "$@"; else command unsnooze _run codex "$@"; fi
}
agy() {
  if [ "${UNSNOOZE_ACTIVE:-}" = 1 ]; then command agy "$@"; else command unsnooze _run agy "$@"; fi
}
