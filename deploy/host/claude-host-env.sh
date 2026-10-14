# Route host root Claude through the account host (source from the host's claude wrapper, e.g. claude-launch).
# The router token is a host-loopback capability (127.0.0.1:18486 is not reachable from any container); the Claude
# login itself stays in the vault. With these set, Claude Code ignores /root/.claude/.credentials.json.
if [ -r /var/lib/unsnooze/router-token ] && systemctl is-active -q unsnooze-host-local.socket; then
  unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
  export ANTHROPIC_BASE_URL=http://127.0.0.1:18486/claude
  CLAUDE_CODE_OAUTH_TOKEN=$(cat /var/lib/unsnooze/router-token)
  export CLAUDE_CODE_OAUTH_TOKEN
fi
