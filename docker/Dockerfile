FROM node:22-alpine

RUN mkdir -p /opt/app

WORKDIR /opt/app

COPY . /opt/app

RUN apk add --update supervisor && rm -rf /tmp/* /var/cache/apk/*
RUN npm install --production

COPY ./docker/supervisord.conf /etc/supervisord.conf

CMD ["supervisord", "-c", "/etc/supervisord.conf"]
