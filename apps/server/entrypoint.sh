#!/bin/sh
set -eu
umask 077
if [ "${RELAY_MASTER+set}" != set ]; then
  echo "RELAY_MASTER is not set, and the server would make a master of its own" >&2
  exit 1
fi
printf '%s\n' "$RELAY_MASTER" >"$RELAY_MASTER_FILE"
unset RELAY_MASTER
exec "$@"
