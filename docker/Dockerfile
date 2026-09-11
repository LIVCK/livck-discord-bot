FROM node:22-alpine

RUN mkdir -p /opt/app

WORKDIR /opt/app

COPY . /opt/app

RUN apk add --update supervisor && rm -rf /tmp/* /var/cache/apk/*
# `npm ci`, not `npm install`: it installs exactly what package-lock.json says and fails when
# the lock and package.json disagree. That matters more here than usual — the postinstall step
# rewrites two files inside discord.js, so the bot is tied to one exact version of its source.
# A resolved-fresh install picks up 14.27, where those lines have moved, and the patch fails.
RUN npm ci --omit=dev

COPY ./docker/supervisord.conf /etc/supervisord.conf
COPY ./docker/entrypoint.sh /opt/app/entrypoint.sh
RUN chmod +x /opt/app/entrypoint.sh

# Migrations run before the bot does — see entrypoint.sh. Starting the process directly meant
# a schema change had to be remembered by whoever deployed, and this release adds columns the
# update loop reads on every single cycle.
CMD ["/opt/app/entrypoint.sh"]
