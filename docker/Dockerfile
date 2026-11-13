FROM node:22-alpine

RUN mkdir -p /opt/app

WORKDIR /opt/app

COPY . /opt/app

# `npm ci`, not `npm install`: it installs exactly what package-lock.json says and fails when
# the lock and package.json disagree. discord.js in particular: the bot refuses to start on a
# version that cannot read the subscribe modal (util/modalSupport.js), and discord/restPolicy.js
# is written against how @discordjs/rest 2.6 answers a 429.
RUN npm ci --omit=dev

COPY ./docker/entrypoint.sh /opt/app/entrypoint.sh
RUN chmod +x /opt/app/entrypoint.sh

# Migrations run before the bot does — see entrypoint.sh. Starting the process directly meant
# a schema change had to be remembered by whoever deployed, and this release adds columns the
# update loop reads on every single cycle.
CMD ["/opt/app/entrypoint.sh"]
