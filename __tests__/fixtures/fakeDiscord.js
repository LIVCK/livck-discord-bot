/**
 * A Discord REST API on 127.0.0.1, for tests that need discord.js itself to run.
 *
 * Mocking `client.channels.fetch` is fine for checking what the bot sends. It is useless for
 * checking how the bot BEHAVES when Discord misbehaves, because that behaviour lives in
 * @discordjs/rest: it queues per route, it sleeps on a 429 and retries without limit, it
 * aborts after 15 seconds and retries that too. None of it runs against a mock. Pointing a
 * real client at this server (`rest: { api: fake.api }`) does run it.
 *
 * Only the routes the update loop uses exist: fetch a channel, post, edit and delete a
 * message. Every channel answers normally until a test scripts it otherwise:
 *
 *   ok           - 200 with a plausible body and rate limit headers
 *   forbidden    - 403, code 50013 on messages (the bot may see the channel but not post)
 *   unknown      - 404, code 10003 (the channel is gone)
 *   rateLimited  - 429 on every request, for as long as it stays scripted
 *   hang         - accepts the request and never answers
 *   loseAnswer   - does what was asked — the message is posted or edited — and never answers,
 *                  the way a response lost on the way back looks to the client
 *   badGateway   - does what was asked, then answers 502: Cloudflare giving up on Discord
 *                  after Discord had already done it. @discordjs/rest retries a 5xx.
 *   serverError  - 500
 *   reset        - drops the connection without a word
 *   { delayMs }  - answers normally, late
 *
 * A POST carrying `enforce_nonce` with a nonce this server has seen in the last five minutes
 * returns the message that nonce made, as Discord does, instead of making another.
 *
 * The bodies follow the shapes in Discord's API reference. They are not recordings; anything
 * the bot depends on that only real Discord can confirm stays in __tests__/e2e/discord.live.test.js.
 */

import http from 'node:http';

export const BOT_ID = '1100000000000000001';

let snowflake = 1200000000000000000n;
const nextId = () => String(snowflake += 1n);

const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
};

const bucketHeaders = (route, { limit = 5, remaining = 4, resetAfter = 1 } = {}) => ({
    'x-ratelimit-bucket': `fake-${route}`,
    'x-ratelimit-limit': String(limit),
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-reset-after': String(resetAfter),
    'x-ratelimit-reset': String(Date.now() / 1000 + resetAfter),
});

const readBody = (req) => new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
        try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
});

/**
 * @param {object} [options]
 * @param {string} [options.guildId]
 * @param {number} [options.retryAfterSeconds] - what a scripted `rateLimited` channel asks for
 * @param {{limit: number, windowSeconds: number}} [options.bucket] - per route and channel, like
 *   Discord's 5 messages per 5 seconds per channel. A client that ignores the headers and
 *   sends anyway gets a real 429 for it, counted like any other.
 */
export const startFakeDiscord = async ({
    guildId = '1300000000000000001',
    retryAfterSeconds = 0.25,
    bucket = { limit: 5, windowSeconds: 5 },
} = {}) => {
    /** `${METHOD} ${route}` → { count, resetAt } */
    const buckets = new Map();

    /** Take one request from a route's bucket for one channel. */
    const take = (key, channelId) => {
        const now = Date.now();
        let state = buckets.get(`${key} ${channelId}`);
        if (!state || state.resetAt <= now) {
            state = { count: 0, resetAt: now + bucket.windowSeconds * 1000 };
            buckets.set(`${key} ${channelId}`, state);
        }
        const resetAfter = Math.max(0.001, (state.resetAt - now) / 1000);
        if (state.count >= bucket.limit) return { exhausted: true, resetAfter };
        state.count += 1;
        return {
            exhausted: false,
            headers: bucketHeaders(key.replace(/\s+/g, '-'), {
                limit: bucket.limit, remaining: bucket.limit - state.count, resetAfter,
            }),
        };
    };

    /** channelId → behaviour */
    const scripts = new Map();
    /** messageId → stored message */
    const messages = new Map();
    /** Every request, in order. */
    const log = [];
    /** Requests left open by `hang`, so they can be let go at the end. */
    const hanging = new Set();
    /** `${channelId}:${nonce}` → { id, at } for enforce_nonce */
    const nonces = new Map();
    const NONCE_WINDOW_MS = 5 * 60 * 1000;

    const channelBody = (id) => ({
        id,
        type: 0,
        guild_id: guildId,
        name: `fake-${id.slice(-4)}`,
        position: 0,
        permission_overwrites: [],
        nsfw: false,
        parent_id: null,
        topic: null,
        last_message_id: null,
        rate_limit_per_user: 0,
        flags: 0,
    });

    const messageBody = (channelId, body, existing = null) => ({
        id: existing?.id ?? nextId(),
        channel_id: channelId,
        guild_id: guildId,
        author: { id: BOT_ID, username: 'fake-bot', discriminator: '0', global_name: null, avatar: null, bot: true },
        content: body.content ?? existing?.content ?? '',
        timestamp: existing?.timestamp ?? new Date().toISOString(),
        edited_timestamp: existing ? new Date().toISOString() : null,
        tts: false,
        mention_everyone: false,
        mentions: [],
        mention_roles: [],
        attachments: [],
        embeds: body.embeds ?? existing?.embeds ?? [],
        components: body.components ?? existing?.components ?? [],
        pinned: false,
        type: body.message_reference || existing?.message_reference ? 19 : 0,
        ...(body.message_reference ? { message_reference: body.message_reference } : {}),
        flags: 0,
    });

    /** What every channel does when nothing is scripted for it. */
    const answerNormally = async (req, res, entry, channelId, messagesPart, messageId, route) => {
        const taken = take(`${req.method} ${route}`, channelId);
        if (taken.exhausted) {
            return json(res, 429, {
                message: 'You are being rate limited.',
                retry_after: taken.resetAfter,
                global: false,
            }, {
                ...bucketHeaders(route, { limit: bucket.limit, remaining: 0, resetAfter: taken.resetAfter }),
                'retry-after': String(Math.ceil(taken.resetAfter)),
                'x-ratelimit-scope': 'user',
            });
        }
        const headers = taken.headers;

        if (!messagesPart) {
            if (req.method !== 'GET') return json(res, 405, { message: '405: Method Not Allowed', code: 0 });
            return json(res, 200, channelBody(channelId), headers);
        }

        if (req.method === 'POST' && !messageId) {
            const body = await readBody(req);
            const seen = body.enforce_nonce && body.nonce ? nonces.get(`${channelId}:${body.nonce}`) : null;
            if (seen && Date.now() - seen.at < NONCE_WINDOW_MS && messages.has(seen.id)) {
                entry.messageId = seen.id;
                entry.deduplicated = true;
                return json(res, 200, messages.get(seen.id), headers);
            }
            const message = messageBody(channelId, body);
            messages.set(message.id, message);
            if (body.enforce_nonce && body.nonce) nonces.set(`${channelId}:${body.nonce}`, { id: message.id, at: Date.now() });
            entry.messageId = message.id;
            return json(res, 200, message, headers);
        }

        const existing = messageId ? messages.get(messageId) : null;
        if (!existing || existing.channel_id !== channelId) {
            return json(res, 404, { message: 'Unknown Message', code: 10008 }, headers);
        }

        if (req.method === 'PATCH') {
            const updated = messageBody(channelId, await readBody(req), existing);
            messages.set(messageId, updated);
            return json(res, 200, updated, headers);
        }
        if (req.method === 'DELETE') {
            messages.delete(messageId);
            res.writeHead(204, headers);
            return res.end();
        }

        return json(res, 405, { message: '405: Method Not Allowed', code: 0 });
    };

    const answer = async (req, res, entry) => {
        const match = req.url.match(/^\/api\/v\d+\/channels\/(\d+)(\/messages(?:\/(\d+))?)?\/?(\?.*)?$/);
        if (!match) return json(res, 404, { message: '404: Not Found', code: 0 });

        const [, channelId, messagesPart, messageId] = match;
        entry.channelId = channelId;
        entry.messageId = messageId ?? null;

        // The bucket HASH names the route, the same for every channel, exactly as Discord sends
        // it; the channel is the major parameter that discord.js keys its state by. A hash per
        // channel looks harmless and is not: discord.js remembers one hash per route, so every
        // other channel's answer overwrote it, its counters were thrown away, and it sent
        // straight into exhausted buckets. Counting is still per channel, below.
        const route = !messagesPart ? 'channel' : messageId ? 'message' : 'messages';
        const behaviour = scripts.get(channelId) ?? 'ok';

        if (behaviour === 'hang') {
            entry.status = 'hang';
            hanging.add(res);
            res.on('close', () => hanging.delete(res));
            return undefined;
        }
        if (behaviour === 'reset') {
            entry.status = 'reset';
            req.socket.destroy();
            return undefined;
        }
        if (behaviour === 'serverError') {
            return json(res, 500, { message: 'Internal Server Error', code: 0 });
        }
        if (behaviour === 'badGateway') {
            const discarded = { ...res, writeHead: () => discarded, end: () => discarded };
            await answerNormally(req, discarded, entry, channelId, messagesPart, messageId, route);
            return json(res, 502, { message: 'Bad Gateway', code: 0 });
        }
        if (behaviour === 'loseAnswer') {
            // Answer into nothing: the work is done, the client never hears of it.
            const swallowed = { ...res, writeHead: () => swallowed, end: () => swallowed };
            hanging.add(res);
            res.on('close', () => hanging.delete(res));
            entry.lost = true;
            await answerNormally(req, swallowed, entry, channelId, messagesPart, messageId, route);
            entry.status = 'lost';
            return undefined;
        }
        if (behaviour === 'rateLimited') {
            return json(res, 429, {
                message: 'You are being rate limited.',
                retry_after: retryAfterSeconds,
                global: false,
            }, {
                ...bucketHeaders(route, { remaining: 0, resetAfter: retryAfterSeconds }),
                'retry-after': String(retryAfterSeconds),
                'x-ratelimit-scope': 'user',
            });
        }
        // The channel itself stays readable — that is what 50013 means, as opposed to 50001.
        if (behaviour === 'forbidden' && messagesPart) {
            return json(res, 403, { message: 'Missing Permissions', code: 50013 });
        }
        if (behaviour === 'unknown') {
            return json(res, 404, { message: 'Unknown Channel', code: 10003 });
        }
        if (behaviour && typeof behaviour === 'object' && behaviour.delayMs) {
            await new Promise((resolve) => setTimeout(resolve, behaviour.delayMs));
        }

        return answerNormally(req, res, entry, channelId, messagesPart, messageId, route);
    };

    const server = http.createServer((req, res) => {
        const entry = { method: req.method, url: req.url, at: Date.now(), status: null };
        log.push(entry);

        const writeHead = res.writeHead.bind(res);
        res.writeHead = (status, ...rest) => {
            entry.status = status;
            return writeHead(status, ...rest);
        };

        answer(req, res, entry).catch((error) => {
            if (!res.headersSent) json(res, 500, { message: String(error), code: 0 });
        });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    const forChannel = (channelId) => log.filter((entry) => entry.channelId === channelId);

    return {
        /** For `new Client({ rest: { api } })`. */
        api: `http://127.0.0.1:${port}/api`,
        guildId,
        log,
        messages,

        script(channelId, behaviour) {
            scripts.set(String(channelId), behaviour);
        },

        /** Requests that reached a channel, optionally filtered by method and status. */
        requests(channelId, { method, status } = {}) {
            return forChannel(String(channelId)).filter((entry) =>
                (!method || entry.method === method) && (status === undefined || entry.status === status));
        },

        /** Messages currently in a channel. */
        messagesIn(channelId) {
            return [...messages.values()].filter((message) => message.channel_id === String(channelId));
        },

        /** 401, 403 and 429 — what Discord counts towards its invalid request ban. */
        invalidRequests() {
            return log.filter((entry) => [401, 403, 429].includes(entry.status));
        },

        /** Let every scripted channel behave again and answer what is still hanging. */
        release() {
            scripts.clear();
            for (const res of hanging) {
                if (!res.headersSent) json(res, 503, { message: 'released', code: 0 });
            }
            hanging.clear();
        },

        async close() {
            this.release();
            server.closeAllConnections?.();
            await new Promise((resolve) => server.close(resolve));
        },
    };
};

export default startFakeDiscord;
