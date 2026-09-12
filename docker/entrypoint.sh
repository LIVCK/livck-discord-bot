#!/bin/sh
#
# Migrate, then BECOME the bot.
#
# `exec`, so node is PID 1: it receives SIGTERM directly on `docker stop`, and its exit code is
# the container's exit code.
#
# This used to hand off to supervisord, which is one process manager too many for a container
# running one process — and it actively hid failure. The bot exits non-zero on every condition
# it cannot work under: no configuration, no database, a rejected command registration, an
# unpatched discord.js. supervisord retried four times, gave up, marked the program FATAL, and
# then kept running as PID 1. The container stayed `running` with exit code 0 while doing
# nothing at all, for ever — indistinguishable from a healthy one in `docker ps`, to a health
# check, or to an orchestrator. Measured: status "running", exit code 0, four failed starts.
#
# Now a container that cannot work stops and says why, and whatever supervises it — Docker's
# own restart policy, Kubernetes, systemd — sees a non-zero exit and can act.
#
# `set -e` plus migrate.js's exit code is the other half: a failed or half-applied migration
# stops the container instead of starting a bot against a schema it cannot use.

set -e

echo "[entrypoint] Running database migrations…"
node /opt/app/migrate.js

echo "[entrypoint] Migrations complete, starting the bot."
exec node /opt/app/server.js
