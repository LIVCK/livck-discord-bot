/**
 * A whole Discord on 127.0.0.1: REST, the gateway, guilds the bot is in or was thrown out of,
 * channels it may or may not see — and a referee that watches every request the bot makes.
 *
 * __tests__/fixtures/fakeDiscord.js serves the REST routes the update loop needs and nothing
 * else, which is enough for a discord.js client a test builds itself. The REAL bot process needs
 * more: it asks REST where the gateway is, logs in over a WebSocket, learns its guilds from
 * READY and GUILD_CREATE, hears about a kick as GUILD_DELETE and registers its commands on
 * startup. All of that is here, close enough to Discord's documented behaviour that discord.js
 * cannot tell the difference.
 *
 * THE REFEREE. Every rule below is checked on the request that breaks it, as it arrives, and
 * recorded in `violations` with what was sent and when — a scenario fails on the first one:
 *
 *   duplicate        a message whose content is already in that channel, posted again
 *   reply-orphan     a reply to a message that is not in the channel
 *   noop-edit        an edit that changes nothing a reader can see — unless the bot never
 *                    learned that its previous write arrived (a lost answer, a 502): then
 *                    sending it again is the only thing it can do
 *   not-a-member     a request to a guild the bot is not in: any at all once it learned so at
 *                    login; after a live kick, more than a few stragglers discord.js already had
 *                    queued, or any after half a minute
 *   limits           a message Discord would reject for its size (it is rejected here too)
 *   unknown-route    anything the bot was never meant to call
 *   burst            the bot running into Discord's global limit (50 a second) again and
 *                    again: more than five global 429s inside ten seconds. One is not a fault
 *                    of the bot — a process that replaces a killed one cannot know what the
 *                    dead one spent of the current second — and is answered like Discord does.
 *
 * Invalid requests (401, 403, 429), which are what Discord bans an IP for, are counted per
 * ten-minute window; a scenario sets its own ceiling.
 *
 * Channels have an ACCESS, which is the Discord state of the channel, and a FAULT, which is the
 * network between the bot and Discord:
 *
 *   access  ok | readonly (50013 on messages) | hidden (50001) | deleted (10003)
 *   fault   none | hang | loseAnswer | badGateway | serverError | reset | rateLimited | {delayMs}
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

export const BOT_ID = '1100000000000000001';

/** The id of the role with Administrator that every simulated guild has. */
export const adminRole = (guildId) => String(BigInt(guildId) + 100000000000000000n);
export const APP_ID = '1100000000000000002';

const DISCORD_EPOCH = 1420070400000n;
let increment = 0n;
/** Real snowflakes: discord.js reads creation times out of them, and they sort by time. */
const snowflake = () => {
    increment = (increment + 1n) & 0xFFFn;
    return String(((BigInt(Date.now()) - DISCORD_EPOCH) << 22n) | increment);
};

const GLOBAL_PER_SECOND = 50;

const json = (res, status, body, headers = {}) => {
    if (res.headersSent || res.writableEnded) return;
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
};

const readBody = (req) => new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
        try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
});

/** What a reader sees of a message, for comparing two of them. Timestamps are not content. */
export const visible = (message) => JSON.stringify({
    content: message.content ?? '',
    embeds: (message.embeds ?? []).map(({ timestamp: _t, ...embed }) => embed),
    components: message.components ?? [],
});

/** Discord's documented limits for a message. Returns what is wrong, or null. */
const overLimit = (body) => {
    const problems = [];
    if ((body.content ?? '').length > 2000) problems.push('content over 2000');
    const embeds = body.embeds ?? [];
    if (embeds.length > 10) problems.push(`${embeds.length} embeds`);
    let total = 0;
    for (const [i, embed] of embeds.entries()) {
        const add = (value, max, what) => {
            const length = (value ?? '').length;
            total += length;
            if (length > max) problems.push(`embed ${i} ${what} ${length} > ${max}`);
        };
        add(embed.title, 256, 'title');
        add(embed.description, 4096, 'description');
        add(embed.footer?.text, 2048, 'footer');
        add(embed.author?.name, 256, 'author');
        const fields = embed.fields ?? [];
        if (fields.length > 25) problems.push(`embed ${i} has ${fields.length} fields`);
        for (const field of fields) {
            add(field.name, 256, 'field name');
            add(field.value, 1024, 'field value');
            if (!field.name || !field.value) problems.push(`embed ${i} has an empty field`);
        }
    }
    if (total > 6000) problems.push(`embeds total ${total} > 6000`);
    if ((body.components ?? []).length > 5) problems.push(`${body.components.length} component rows`);
    return problems.length > 0 ? problems.join('; ') : null;
};

/**
 * @param {object} [options]
 * @param {number} [options.memberGraceMs] - how long after a kick a request still counts as
 *   one that was already on its way
 * @param {number} [options.heartbeatMs] - the gateway heartbeat interval announced in HELLO
 */
export const startSimDiscord = async ({ memberGraceMs = 3000, heartbeatMs = 5000 } = {}) => {
    /** id → { id, name, member, since, leftAt, channels: Set } */
    const guilds = new Map();
    /** id → { id, guildId, name, access, fault } */
    const channels = new Map();
    /** id → stored message */
    const messages = new Map();
    /** `${channelId}:${nonce}` → { id, at } */
    const nonces = new Map();
    /** Every REST request, in order. */
    const log = [];
    const violations = [];
    const hanging = new Set();
    /** Per channel and route: Discord's 5 messages per 5 seconds. */
    const buckets = new Map();
    /** Discord's global limit: a fixed one-second window, as @discordjs/rest also counts it. */
    let globalWindow = { start: 0, count: 0 };
    /** When the global limit answered 429. */
    const globalRefusals = [];
    /** Gateway sessions. */
    const sockets = new Set();
    let readyAt = null;
    let sequence = 0;
    let commands = [];
    let created = 0;
    let beforeAnswer = null;
    /** Interaction responses, by interaction id. */
    const interactionAnswers = new Map();

    const violate = (rule, detail) => {
        violations.push({ rule, at: Date.now(), detail });
    };

    // ---- REST ---------------------------------------------------------------------------

    const take = (key) => {
        const now = Date.now();
        let state = buckets.get(key);
        if (!state || state.resetAt <= now) {
            state = { count: 0, resetAt: now + 5000 };
            buckets.set(key, state);
        }
        const resetAfter = Math.max(0.001, (state.resetAt - now) / 1000);
        const headers = {
            'x-ratelimit-bucket': `sim-${key.split(' ')[0]}`,
            'x-ratelimit-limit': '5',
            'x-ratelimit-remaining': String(Math.max(0, 5 - state.count - 1)),
            'x-ratelimit-reset-after': String(resetAfter),
            'x-ratelimit-reset': String(state.resetAt / 1000),
        };
        if (state.count >= 5) return { exhausted: true, resetAfter, headers: { ...headers, 'x-ratelimit-remaining': '0' } };
        state.count += 1;
        return { exhausted: false, headers };
    };

    const tooMany = (res, resetAfter, headers, global = false) => json(res, 429, {
        message: 'You are being rate limited.', retry_after: resetAfter, global,
    }, { ...headers, 'retry-after': String(Math.ceil(resetAfter)), 'x-ratelimit-scope': global ? 'global' : 'user' });

    const channelBody = (channel) => ({
        id: channel.id, type: 0, guild_id: channel.guildId, name: channel.name, position: 0,
        permission_overwrites: [], nsfw: false, parent_id: null, topic: null,
        last_message_id: null, rate_limit_per_user: 0, flags: 0,
    });

    const messageBody = (channelId, body, existing = null) => ({
        id: existing?.id ?? snowflake(),
        channel_id: channelId,
        guild_id: channels.get(channelId)?.guildId,
        author: { id: BOT_ID, username: 'sim-bot', discriminator: '0', global_name: null, avatar: null, bot: true },
        content: body.content ?? existing?.content ?? '',
        timestamp: existing?.timestamp ?? new Date().toISOString(),
        edited_timestamp: existing ? new Date().toISOString() : null,
        tts: false, mention_everyone: false, mentions: [], mention_roles: [], attachments: [], pinned: false,
        embeds: body.embeds ?? existing?.embeds ?? [],
        components: body.components ?? existing?.components ?? [],
        type: (body.message_reference ?? existing?.message_reference) ? 19 : 0,
        ...((body.message_reference ?? existing?.message_reference)
            ? { message_reference: body.message_reference ?? existing.message_reference } : {}),
        flags: 0,
    });

    /** The channel as Discord would answer for it, or the error it would answer with. */
    const accessOf = (channelId, messagesPart) => {
        const channel = channels.get(channelId);
        if (!channel || channel.access === 'deleted') return { status: 404, body: { message: 'Unknown Channel', code: 10003 } };
        const guild = guilds.get(channel.guildId);
        if (!guild?.member || channel.access === 'hidden') return { status: 403, body: { message: 'Missing Access', code: 50001 } };
        if (channel.access === 'readonly' && messagesPart && channel.writeBlocked !== false) {
            return { status: 403, body: { message: 'Missing Permissions', code: 50013 } };
        }
        return null;
    };

    const checkMembership = (channelId, entry) => {
        const channel = channels.get(channelId);
        if (!channel || !readyAt) return;
        const guild = guilds.get(channel.guildId);
        if (!guild || guild.member) return;
        // Told live (GUILD_DELETE while connected): what discord.js already had queued or was
        // retrying still goes out — a straggler or two inside half a minute is not the bot asking
        // again. Learned at login: nothing was queued, so nothing at all.
        const live = guild.leftAt && guild.leftAt > readyAt;
        const since = Math.max(guild.leftAt ?? 0, readyAt);
        const after = entry.at - since;
        guild.stragglers = (guild.stragglers ?? 0) + (after > memberGraceMs ? 1 : 0);
        if (after > memberGraceMs && (!live || after > 30_000 || guild.stragglers > 5)) {
            violate('not-a-member', `${entry.method} ${entry.url} to guild ${guild.id}, ${after}ms after the bot left it`);
        }
    };

    const handleMessages = async (req, res, entry, channel, messageId) => {
        const route = messageId ? 'message' : 'messages';
        const taken = take(`${req.method}-${route} ${channel.id}`);
        if (taken.exhausted) return tooMany(res, taken.resetAfter, taken.headers);

        if (req.method === 'POST' && !messageId) {
            const body = await readBody(req);
            entry.body = body;
            const limit = overLimit(body);
            if (limit) {
                violate('limits', `POST to ${channel.id}: ${limit}`);
                return json(res, 400, { message: 'Invalid Form Body', code: 50035 }, taken.headers);
            }
            const seen = body.enforce_nonce && body.nonce ? nonces.get(`${channel.id}:${body.nonce}`) : null;
            if (seen && Date.now() - seen.at < 5 * 60 * 1000) {
                // As Discord does (checked against the real API): the message that nonce made,
                // as it is — old content and all — or 10008 if it has been deleted since.
                if (!messages.has(seen.id)) return json(res, 404, { message: 'Unknown Message', code: 10008 }, taken.headers);
                entry.messageId = seen.id;
                entry.deduplicated = true;
                return json(res, 200, messages.get(seen.id), taken.headers);
            }
            const reference = body.message_reference?.message_id;
            if (reference) {
                const parent = messages.get(reference);
                if (!parent || parent.channel_id !== channel.id) {
                    violate('reply-orphan', `reply in ${channel.id} to ${reference}, which is not there`);
                    if (body.message_reference.fail_if_not_exists !== false) {
                        return json(res, 400, { message: 'Invalid Form Body', code: 50035 }, taken.headers);
                    }
                    delete body.message_reference;
                }
            }
            const message = messageBody(channel.id, body);
            message.clientKnows = !res.swallowed;
            const fingerprint = visible(message);
            const twin = [...messages.values()].find((m) => m.channel_id === channel.id && visible(m) === fingerprint);
            if (twin) violate('duplicate', `in ${channel.id}: ${message.id} repeats ${twin.id} — ${describe(message)}`);
            messages.set(message.id, message);
            if (body.enforce_nonce && body.nonce) nonces.set(`${channel.id}:${body.nonce}`, { id: message.id, at: Date.now() });
            entry.messageId = message.id;
            created += 1;
            // The message exists, the answer has not left: the moment a scenario can kill the
            // bot in, to leave a message in the channel and no row in its database.
            if (beforeAnswer) await beforeAnswer({ count: created, message });
            return json(res, 200, message, taken.headers);
        }

        const existing = messageId ? messages.get(messageId) : null;
        if (!existing || existing.channel_id !== channel.id) {
            return json(res, 404, { message: 'Unknown Message', code: 10008 }, taken.headers);
        }
        if (req.method === 'GET') return json(res, 200, existing, taken.headers);
        if (req.method === 'PATCH') {
            const body = await readBody(req);
            entry.body = body;
            const limit = overLimit({ ...existing, ...body });
            if (limit) {
                violate('limits', `PATCH ${messageId}: ${limit}`);
                return json(res, 400, { message: 'Invalid Form Body', code: 50035 }, taken.headers);
            }
            const updated = messageBody(channel.id, body, existing);
            if (visible(updated) === visible(existing) && existing.clientKnows !== false) {
                violate('noop-edit', `${messageId} in ${channel.id} — ${describe(existing)}`);
            }
            updated.clientKnows = !res.swallowed;
            messages.set(messageId, updated);
            return json(res, 200, updated, taken.headers);
        }
        if (req.method === 'DELETE') {
            messages.delete(messageId);
            res.writeHead(204, taken.headers);
            return res.end();
        }
        return json(res, 405, { message: '405: Method Not Allowed', code: 0 });
    };

    const handleChannel = async (req, res, entry, channelId, messagesPart, messageId) => {
        entry.channelId = channelId;
        checkMembership(channelId, entry);

        const channel = channels.get(channelId);
        const fault = channel?.fault ?? 'none';

        if (fault === 'hang') {
            entry.status = 'hang';
            hanging.add(res);
            res.on('close', () => hanging.delete(res));
            return undefined;
        }
        if (fault === 'reset') { entry.status = 'reset'; req.socket.destroy(); return undefined; }
        if (fault === 'serverError') return json(res, 500, { message: 'Internal Server Error', code: 0 });
        if (fault === 'rateLimited') return tooMany(res, 1, {});
        if (fault && typeof fault === 'object' && fault.delayMs) {
            await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
        }

        const denied = accessOf(channelId, messagesPart);
        if (denied) return json(res, denied.status, denied.body);

        const run = (target) => (messagesPart
            ? handleMessages(req, target, entry, channel, messageId)
            : json(target, req.method === 'GET' ? 200 : 405, req.method === 'GET' ? channelBody(channel) : { message: '405', code: 0 }));

        if (fault === 'badGateway' || fault === 'loseAnswer') {
            // Discord does it; the answer never arrives intact.
            const swallowed = { swallowed: true, headersSent: false, writableEnded: false, writeHead: () => swallowed, end: () => swallowed };
            await run(swallowed);
            if (fault === 'badGateway') return json(res, 502, { message: 'Bad Gateway', code: 0 });
            entry.status = 'lost';
            hanging.add(res);
            res.on('close', () => hanging.delete(res));
            return undefined;
        }
        return run(res);
    };

    const handleInteraction = async (req, res, entry, interactionId) => {
        const body = await readBody(req);
        entry.body = body;
        const answers = interactionAnswers.get(interactionId) ?? [];
        answers.push(body);
        interactionAnswers.set(interactionId, answers);
        res.writeHead(204);
        return res.end();
    };

    const handleWebhook = async (req, res, entry, token, messageId) => {
        const body = req.method === 'GET' ? {} : await readBody(req);
        entry.body = body;
        const key = `webhook:${token}`;
        const answers = interactionAnswers.get(key) ?? [];
        answers.push({ method: req.method, messageId, body });
        interactionAnswers.set(key, answers);
        return json(res, 200, messageBody('0', body, messageId ? messages.get(messageId) : null));
    };

    const route = async (req, res, entry) => {
        const url = decodeURIComponent(req.url.replace(/\?.*$/, ''));
        let m;
        if ((m = url.match(/^\/api\/v\d+\/channels\/(\d+)(\/messages(?:\/(\d+))?)?\/?$/))) {
            return handleChannel(req, res, entry, m[1], m[2], m[3]);
        }
        if (url.match(/^\/api\/v\d+\/gateway(\/bot)?$/)) {
            return json(res, 200, {
                url: gatewayUrl, shards: 1,
                session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 },
            });
        }
        if ((m = url.match(/^\/api\/v\d+\/applications\/(\d+)\/commands$/)) && req.method === 'PUT') {
            const body = await readBody(req);
            commands = body.map((command) => ({ ...command, id: snowflake(), application_id: APP_ID, version: '1' }));
            return json(res, 200, commands);
        }
        if ((m = url.match(/^\/api\/v\d+\/interactions\/(\d+)\/[^/]+\/callback$/))) {
            return handleInteraction(req, res, entry, m[1]);
        }
        if ((m = url.match(/^\/api\/v\d+\/webhooks\/\d+\/([^/]+)(?:\/messages\/(@original|\d+))?$/))) {
            return handleWebhook(req, res, entry, m[1], m[2]);
        }
        violate('unknown-route', `${req.method} ${req.url}`);
        return json(res, 404, { message: '404: Not Found', code: 0 });
    };

    const server = http.createServer((req, res) => {
        const entry = { method: req.method, url: req.url, at: Date.now(), status: null };
        log.push(entry);

        if (entry.at - globalWindow.start >= 1000) globalWindow = { start: entry.at, count: 0 };
        globalWindow.count += 1;
        if (globalWindow.count > GLOBAL_PER_SECOND) {
            globalRefusals.push(entry.at);
            const lately = globalRefusals.filter((at) => entry.at - at < 10_000).length;
            if (lately > 5) violate('burst', `${lately} global 429s inside ten seconds`);
            entry.status = 429;
            return tooMany(res, Math.max(0.001, (globalWindow.start + 1000 - entry.at) / 1000), {}, true);
        }

        const writeHead = res.writeHead.bind(res);
        res.writeHead = (status, ...rest) => { entry.status = status; return writeHead(status, ...rest); };

        route(req, res, entry).catch((error) => json(res, 500, { message: String(error), code: 0 }));
    });

    // ---- Gateway ------------------------------------------------------------------------

    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });

    const send = (ws, payload) => { if (ws.readyState === 1) ws.send(JSON.stringify(payload)); };
    const dispatch = (t, d) => {
        for (const ws of sockets) {
            if (ws.identified) send(ws, { op: 0, t, s: ++sequence, d });
        }
    };

    const guildBody = (guild) => ({
        id: guild.id, name: guild.name, icon: null, splash: null, discovery_splash: null,
        owner_id: '1100000000000000099', afk_channel_id: null, afk_timeout: 300,
        verification_level: 0, default_message_notifications: 0, explicit_content_filter: 0,
        features: [], mfa_level: 0, application_id: null, system_channel_id: null,
        system_channel_flags: 0, rules_channel_id: null, vanity_url_code: null, description: null,
        banner: null, premium_tier: 0, preferred_locale: 'de', public_updates_channel_id: null,
        nsfw_level: 0, premium_progress_bar_enabled: false, safety_alerts_channel_id: null,
        joined_at: new Date(guild.since).toISOString(), large: false, unavailable: false,
        member_count: 2, voice_states: [], presences: [], threads: [], stage_instances: [],
        guild_scheduled_events: [], emojis: [], stickers: [], soundboard_sounds: [],
        roles: [{
            id: guild.id, name: '@everyone', permissions: '2248473465835073', position: 0, color: 0,
            hoist: false, managed: false, mentionable: false, flags: 0, icon: null, unicode_emoji: null,
        }, {
            // What an admin has: discord.js works a member's permissions out from their roles.
            id: adminRole(guild.id), name: 'Admin', permissions: '8', position: 1, color: 0,
            hoist: false, managed: false, mentionable: false, flags: 0, icon: null, unicode_emoji: null,
        }],
        members: [{
            user: { id: BOT_ID, username: 'sim-bot', discriminator: '0', global_name: null, avatar: null, bot: true },
            roles: [], joined_at: new Date(guild.since).toISOString(), deaf: false, mute: false, flags: 0,
        }],
        channels: [...guild.channels].map((id) => channels.get(id))
            .filter((c) => c && c.access !== 'deleted' && c.access !== 'hidden').map(channelBody),
    });

    wss.on('connection', (ws) => {
        sockets.add(ws);
        ws.on('close', () => sockets.delete(ws));
        send(ws, { op: 10, d: { heartbeat_interval: heartbeatMs } });

        ws.on('message', (raw) => {
            let packet;
            try { packet = JSON.parse(String(raw)); } catch { return; }
            if (packet.op === 1) return send(ws, { op: 11 });
            if (packet.op === 6) {
                // No resume here: a fresh identify is always correct, if slower.
                return send(ws, { op: 9, d: false });
            }
            if (packet.op === 2) {
                ws.identified = true;
                const member = [...guilds.values()].filter((g) => g.member);
                send(ws, {
                    op: 0, t: 'READY', s: ++sequence, d: {
                        v: 10,
                        user: { id: BOT_ID, username: 'sim-bot', discriminator: '0', global_name: null, avatar: null, bot: true, flags: 0 },
                        guilds: member.map((g) => ({ id: g.id, unavailable: true })),
                        session_id: crypto.randomBytes(8).toString('hex'),
                        resume_gateway_url: gatewayUrl,
                        application: { id: APP_ID, flags: 0 },
                        shard: [0, 1],
                    },
                });
                for (const guild of member) send(ws, { op: 0, t: 'GUILD_CREATE', s: ++sequence, d: guildBody(guild) });
                readyAt ??= Date.now();
            }
            return undefined;
        });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const gatewayUrl = `ws://127.0.0.1:${port}`;

    const describe = (message) => {
        const embed = message.embeds?.[0];
        return JSON.stringify(embed?.title ?? message.content ?? '').slice(0, 80);
    };

    let nextGuild = 0n;
    let nextChannel = 0n;

    const api = {
        api: `http://127.0.0.1:${port}/api`,
        gatewayUrl,
        log,
        violations,
        messages,

        /** A guild the bot is in from the start (or not, with `member: false`). */
        addGuild({ name, member = true } = {}) {
            const id = String(1300000000000000000n + (nextGuild += 1n));
            guilds.set(id, { id, name: name ?? `guild-${nextGuild}`, member, since: Date.now(), leftAt: member ? null : 0, channels: new Set() });
            return id;
        },

        addChannel(guildId, { name, access = 'ok' } = {}) {
            const id = String(1500000000000000000n + (nextChannel += 1n));
            channels.set(id, { id, guildId, name: name ?? `channel-${nextChannel}`, access, fault: 'none' });
            guilds.get(guildId).channels.add(id);
            return id;
        },

        guild: (id) => guilds.get(id),
        channel: (id) => channels.get(id),

        /** The bot is removed from the guild, live: GUILD_DELETE as Discord sends it for a kick. */
        kick(guildId) {
            const guild = guilds.get(guildId);
            guild.member = false;
            guild.leftAt = Date.now();
            dispatch('GUILD_DELETE', { id: guildId });
        },

        /** Removed while the bot is not connected: nothing is sent, READY just leaves it out. */
        removeQuietly(guildId) {
            const guild = guilds.get(guildId);
            guild.member = false;
            guild.leftAt = Date.now();
        },

        /** Invited (back): GUILD_CREATE. */
        invite(guildId) {
            const guild = guilds.get(guildId);
            guild.member = true;
            guild.leftAt = null;
            guild.since = Date.now();
            dispatch('GUILD_CREATE', guildBody(guild));
        },

        /** A Discord-side outage of a guild: GUILD_DELETE with `unavailable`, then back. */
        outage(guildId) {
            dispatch('GUILD_DELETE', { id: guildId, unavailable: true });
            return () => dispatch('GUILD_CREATE', guildBody(guilds.get(guildId)));
        },

        /** What an admin changing permissions looks like: the channel's access, and the event. */
        setAccess(channelId, access) {
            const channel = channels.get(channelId);
            channel.access = access;
            if (access === 'deleted') dispatch('CHANNEL_DELETE', channelBody(channel));
            else dispatch('CHANNEL_UPDATE', channelBody(channel));
        },

        /** Change access without any event — a role edit somewhere the bot does not hear about. */
        setAccessQuietly(channelId, access) { channels.get(channelId).access = access; },

        fault(channelId, fault) { channels.get(channelId).fault = fault; },

        /** Called with every new message, after Discord made it and before it answers. */
        beforeAnswer(fn) { beforeAnswer = fn; },

        /** Every channel answers again, and whatever is hanging is let go. */
        heal() {
            for (const channel of channels.values()) channel.fault = 'none';
            for (const res of hanging) json(res, 503, { message: 'released', code: 0 });
            hanging.clear();
        },

        /** Drop every gateway connection, the way a Discord-side disconnect looks. */
        disconnectGateway(code = 4000) {
            for (const ws of sockets) ws.close(code, 'sim');
        },

        isConnected: () => [...sockets].some((ws) => ws.identified && ws.readyState === 1),
        readyAt: () => readyAt,
        resetReady() { readyAt = null; },
        commands: () => commands,

        messagesIn(channelId) {
            return [...messages.values()].filter((m) => m.channel_id === channelId)
                .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
        },

        /** Delete a message the way an admin does in the client. */
        deleteByHand(messageId) { messages.delete(messageId); },

        requestsSince(at, filter = () => true) { return log.filter((entry) => entry.at >= at && filter(entry)); },

        /** 401/403/429 inside any ten-minute window, the most there were. */
        invalidRequestPeak() {
            const bad = log.filter((e) => [401, 403, 429].includes(e.status)).map((e) => e.at);
            let peak = 0;
            for (let i = 0, j = 0; i < bad.length; i += 1) {
                while (bad[i] - bad[j] > 10 * 60 * 1000) j += 1;
                peak = Math.max(peak, i - j + 1);
            }
            return peak;
        },

        /** Send an interaction over the gateway, as Discord does when someone uses a command. */
        interact(payload) {
            const id = snowflake();
            const token = crypto.randomBytes(16).toString('hex');
            dispatch('INTERACTION_CREATE', { id, token, application_id: APP_ID, version: 1, ...payload });
            return { id, token, answers: () => interactionAnswers.get(id) ?? [], followups: () => interactionAnswers.get(`webhook:${token}`) ?? [] };
        },

        async close() {
            api.heal();
            for (const ws of sockets) ws.terminate();
            wss.close();
            server.closeAllConnections?.();
            await new Promise((resolve) => server.close(resolve));
        },
    };

    return api;
};

export default startSimDiscord;
