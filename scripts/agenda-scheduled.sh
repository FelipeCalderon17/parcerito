#!/bin/zsh
# Weekday agenda run, started by launchd at 10:10 (see README): waits for today's agenda in the bot DM, then runs
# `npm run agenda` without opening the browser, so the day's Linear issues get their [Agenda - date] title and the
# full Agenda review comment. If the AWS SSO session has expired it still runs, without the prod evidence (--no-db),
# because `aws sso login` would wait for a browser forever.
cd "${0:A:h}/.."
today=$(date +%F)
echo "=== $(date '+%F %T') scheduled agenda run"

for attempt in 1 2 3 4 5 6; do
  npm run -s agenda -- --agenda-only --no-open >/dev/null 2>&1
  [ -f "${AGENDA_LOCAL_DIR:-$HOME/Desktop/Lime/agenda}/nico-sync-$today.html" ] && break
  echo "today's agenda isn't in the DM yet (attempt $attempt), retrying in 5 min"
  sleep 300
done
if [ ! -f "${AGENDA_LOCAL_DIR:-$HOME/Desktop/Lime/agenda}/nico-sync-$today.html" ]; then
  echo "no agenda for $today after 30 min; skipping"
  exit 1
fi

if aws sts get-caller-identity --profile limeai-data >/dev/null 2>&1; then
  npm run -s agenda -- --no-open
else
  echo "AWS session expired: running without prod evidence (log in with: aws sso login --profile limeai-data, then npm run agenda)"
  npm run -s agenda -- --no-open --no-db
fi
echo "=== $(date '+%F %T') done (exit $?)"
