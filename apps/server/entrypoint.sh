#!/bin/sh
set -eu
umask 077
if [ "${RELAY_MASTER+set}" = set ]; then
  printf '%s\n' "$RELAY_MASTER" >"$RELAY_MASTER_FILE"
fi
unset RELAY_MASTER
exec "$@"
