FROM node:22-alpine

RUN mkdir -p /opt/app

WORKDIR /opt/app

COPY . /opt/app

RUN apk add --update supervisor && rm -rf /tmp/* /var/cache/apk/*
RUN npm install --production

COPY ./docker/supervisord.conf /etc/supervisord.conf
COPY ./docker/entrypoint.sh /opt/app/entrypoint.sh
RUN chmod +x /opt/app/entrypoint.sh

# Migrations run before the bot does — see entrypoint.sh. Starting the process directly meant
# a schema change had to be remembered by whoever deployed, and this release adds columns the
# update loop reads on every single cycle.
CMD ["/opt/app/entrypoint.sh"]
