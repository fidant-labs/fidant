#!/bin/sh
set -eu
umask 077
: "${RELAY_MASTER?is not set, and the server would make a master of its own}"
printf '%s\n' "$RELAY_MASTER" >"$RELAY_MASTER_FILE"
unset RELAY_MASTER
exec "$@"
