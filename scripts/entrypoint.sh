#!/bin/sh
# Prepares the /data volume, then drops root and starts the bot as the `node` user
# (Claude Code refuses to skip permission prompts when running as root).
set -e

DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR" "$CODEX_HOME" "$CLAUDE_CONFIG_DIR"

# Optional bootstrap: a base64-encoded ~/.codex/auth.json. Only used if Codex isn't logged in yet,
# because Codex refreshes that file itself afterwards.
if [ -n "$CODEX_AUTH_JSON_B64" ] && [ ! -f "$CODEX_HOME/auth.json" ]; then
  echo "$CODEX_AUTH_JSON_B64" | base64 -d > "$CODEX_HOME/auth.json"
  echo "Wrote Codex login from CODEX_AUTH_JSON_B64"
fi

# Railway mounts volumes as root. Hand them to `node` once; afterwards only re-own the
# small login dirs, in case you logged in through `railway ssh` (which runs as root).
if [ "$(stat -c %U "$DATA_DIR")" != "node" ]; then
  chown -R node:node "$DATA_DIR"
else
  chown -R node:node "$CODEX_HOME" "$CLAUDE_CONFIG_DIR"
fi

export HOME=/home/node
export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-parcerito}"
export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-parcerito@users.noreply.github.com}"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

exec setpriv --reuid=node --regid=node --init-groups sh -c '
  gh auth setup-git
  exec node /app/dist/index.js
'
