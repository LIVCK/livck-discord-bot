#!/bin/sh
#
# Migrate, then run.
#
# The image used to start supervisord directly, and `node migrate.js` existed only as a line
# in the README. That was survivable while the schema never changed. It stopped being
# survivable with the Cloud rollout: the update loop now selects backoffLevel, nextAttemptAt,
# kind and externalId on every cycle, and the alert handler reads Messages.kind — so a
# container built from this code against an un-migrated database fails every query, logs one
# critical error every 15 seconds, delivers nothing, and never exits, which means supervisord's
# autorestart never fires and nothing notices.
#
# `set -e` plus migrate.js's exit code is the whole point: a failed or half-applied migration
# stops the container instead of starting a bot that cannot work.

set -e

echo "[entrypoint] Running database migrations…"
node /opt/app/migrate.js

echo "[entrypoint] Migrations complete, starting the bot."
exec supervisord -c /etc/supervisord.conf
