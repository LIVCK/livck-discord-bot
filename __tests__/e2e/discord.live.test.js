/**
 * The one thing every other test had to fake: Discord itself.
 *
 * Everything else in this suite runs against reality — real status pages, a real database,
 * real Redis. Discord was always a recording stub, because there was no token. So the payload
 * shapes are backed by golden snapshots and by discord.js validating them locally, and nothing
 * more: the API has never seen them.
 *
 * This closes that. It talks to a THROWAWAY bot in a THROWAWAY guild against a THROWAWAY
 * database, and it cleans up after itself.
 *
 * SETUP (once)
 *
 *   1. Discord Developer Portal → New Application → Bot → reset/copy the token.
 *      A NEW application. Never the production one.
 *   2. No privileged intents. The bot uses GatewayIntentBits.Guilds and nothing else.
 *   3. Invite it with scopes `bot` + `applications.commands` and permissions 84992:
 *      View Channels, Send Messages, Embed Links, Read Message History.
 *      Read Message History is not optional — the pause footer fetches the message it edits.
 *   4. Create a throwaway server with one channel.
 *   5. Put the credentials in `.env.test` (already covered by .gitignore's `.env.*`):
 *
 *        DISCORD_BOT_TOKEN=...
 *        DISCORD_CLIENT_ID=...
 *        TEST_GUILD_ID=...
 *        TEST_CHANNEL_ID=...
 *
 * RUN
 *
 *   docker exec mariadb mariadb -u root -e "CREATE DATABASE IF NOT EXISTS livck_bot_discord"
 *   DB_HOST=127.0.0.1 DB_DATABASE=livck_bot_discord DB_USERNAME=root DB_PASSWORD= node migrate.js
 *
 *   LIVCK_DISCORD_E2E=1 DB_HOST=127.0.0.1 DB_DATABASE=livck_bot_discord DB_USERNAME=root \
 *     DB_PASSWORD= REDIS_HOST=127.0.0.1 REDIS_PORT=6379 REDIS_PASSWORD= \
 *     npm test -- __tests__/e2e/discord.live.test.js --runInBand
 *
 * It refuses to run against anything whose database name is not obviously a throwaway.
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// The Discord credentials usually live in `.env`, and Jest loads nothing on its own. `dotenv`
// never overwrites a variable that is already set, so the DB_* passed on the command line
// survive this — and assertThrowaway checks the connection that was actually opened rather
// than trusting that, because `.env` may still be pointing at a production database.
dotenv.config();

const enabled = process.env.LIVCK_DISCORD_E2E === '1';

/** Read `.env.test` without putting it into the process environment of anything else. */
const readCredentials = () => {
    const file = path.resolve('.env.test');
    if (!fs.existsSync(file)) return {};

    return Object.fromEntries(
        fs.readFileSync(file, 'utf8')
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith('#'))
            .map((line) => {
                const at = line.indexOf('=');
                return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
            })
    );
};

/**
 * `.env.test` first, then whatever is already in the environment.
 *
 * The Discord credentials may live in `.env` (dotenv puts them in `process.env`), and the
 * DATABASE deliberately does not come from here at all — it is passed on the command line,
 * where dotenv will not overwrite it, and checked against the real connection in
 * assertThrowaway. That separation is the point: the same `.env` can hold a test token beside
 * a production database, and this suite must never follow it to the second one.
 */
const credentials = enabled
    ? { ...process.env, ...readCredentials() }
    : {};

const ready = enabled
    && credentials.DISCORD_BOT_TOKEN
    && credentials.DISCORD_CLIENT_ID
    && credentials.TEST_GUILD_ID
    && credentials.TEST_CHANNEL_ID;

if (enabled && !ready) {
    const missing = ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID', 'TEST_GUILD_ID', 'TEST_CHANNEL_ID']
        .filter((name) => !credentials[name]);
    console.warn(`[discord-e2e] Skipped — missing: ${missing.join(', ')}`);
}

const e2e = ready ? describe : describe.skip;

/**
 * A guard, not a convenience: this suite writes rows and posts messages.
 *
 * It checks the CONNECTION Sequelize actually opened, not the environment variable that was
 * supposed to shape it. `.env` in this repo still carries production database credentials, and
 * `dotenv` only declines to overwrite a variable that is already set — a convention, and the
 * wrong thing to stake a production database on. A remote host is refused outright, whatever
 * it is called.
 */
const assertThrowaway = (models) => {
    const { host, database } = models.database.config;

    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
        throw new Error(
            `Refusing to run against host "${host}". This suite only ever talks to a local database.`
        );
    }

    if (!/test|e2e|discord|throwaway|scratch/i.test(database || '')) {
        throw new Error(
            `Refusing to run against database "${database}". Point DB_DATABASE at a throwaway.`
        );
    }

    console.log(`[discord-e2e] Using ${host}/${database}`);
};

e2e('against a real Discord bot', () => {
    let client;
    let models;
    let channel;
    let runCycle;
    let clearSnapshotCache;

    /** Everything this suite created, so it can be removed again. */
    const posted = [];

    /**
     * Read a message from the API, not from discord.js's cache.
     *
     * The cache holds the message as it looked when the bot last saw it, so a plain
     * `messages.fetch(id)` right after the bot edited it hands back the version BEFORE the
     * edit — and every assertion about what the reader now sees would be checking the wrong
     * object. This is a property of the test, not of the bot.
     */
    const fetchFresh = (messageId) => channel.messages.fetch({ message: messageId, force: true });

    const PAGES = [
        { url: 'https://status.livck.com', name: 'status.livck.com', kind: 'SELF_HOSTED' },
        { url: 'https://cloud.statuspage.de', name: 'cloud.statuspage.de', kind: 'CLOUD' },
    ];

    const LAYOUTS = ['DETAILED', 'COMPACT', 'OVERVIEW', 'TREE', 'MINIMAL'];

    beforeAll(async () => {
        models = (await import('../../models/index.js')).default;
        assertThrowaway(models);

        process.env.DISCORD_BOT_TOKEN = credentials.DISCORD_BOT_TOKEN;
        process.env.DISCORD_CLIENT_ID = credentials.DISCORD_CLIENT_ID;

        const { Client, GatewayIntentBits } = await import('discord.js');
        client = new Client({ intents: [GatewayIntentBits.Guilds] });
        await client.login(credentials.DISCORD_BOT_TOKEN);

        channel = await client.channels.fetch(credentials.TEST_CHANNEL_ID);

        ({ runCycle } = await import('../../services/updateLoop.js'));
        ({ clearSnapshotCache } = await import('../../providers/index.js'));

        await models.Message.destroy({ where: {}, truncate: true, cascade: true });
        await models.Subscription.destroy({ where: {} });
        await models.Statuspage.destroy({ where: {} });
    }, 120000);

    afterAll(async () => {
        // Leave the channel as it was found.
        for (const messageId of posted) {
            await channel?.messages?.delete(messageId).catch(() => {});
        }
        if (models) await models.database.close();
        if (client) await client.destroy();

        const cache = (await import('../../database/redis.js')).default;
        if (cache?.isOpen) await cache.quit();
    }, 120000);

    /** Remember what the bot posted, so afterAll can clean it up. */
    const track = async () => {
        const rows = await models.Message.findAll();
        for (const row of rows) if (!posted.includes(row.messageId)) posted.push(row.messageId);
    };

    describe('the slash commands', () => {
        test('Discord accepts the registration payload', async () => {
            // The whole set is validated together: one oversized localized description and the
            // bot ends up with no commands at all. This is the only way to know it fits.
            const { REST, Routes } = await import('discord.js');
            const commandsFolder = path.resolve('./discord/commands');

            const commands = [];
            for (const file of fs.readdirSync(commandsFolder).filter((f) => f.endsWith('.js'))) {
                commands.push((await import(path.join(commandsFolder, file))).default(models).data);
            }

            const rest = new REST({ version: '10' }).setToken(credentials.DISCORD_BOT_TOKEN);

            // Guild-scoped, so the throwaway guild is the only thing touched.
            const registered = await rest.put(
                Routes.applicationGuildCommands(credentials.DISCORD_CLIENT_ID, credentials.TEST_GUILD_ID),
                { body: commands }
            );

            expect(registered.map((c) => c.name).sort()).toEqual(commands.map((c) => c.name).sort());
        }, 60000);
    });

    describe('a status message', () => {
        let page;
        let subscription;

        /** Drop every claim, so the next runCycle actually does the work. */
        const nextCycle = async () => {
            const cache = (await import('../../database/redis.js')).default;
            for (const row of await models.Statuspage.findAll()) {
                await cache.del(`dc-bot:statuspage:${row.id}`);
            }
            clearSnapshotCache();
        };

        beforeAll(async () => {
            page = await models.Statuspage.create({ url: PAGES[0].url, name: PAGES[0].name });

            // ONE subscription. There is a unique index on
            // (guildId, channelId, statuspageId, locale), so a channel cannot hold the same
            // page twice in the same language — the layouts are exercised by switching this
            // one over, which also puts the "layout changed" edit through the real API.
            subscription = await models.Subscription.create({
                guildId: credentials.TEST_GUILD_ID,
                channelId: credentials.TEST_CHANNEL_ID,
                statuspageId: page.id,
                layout: 'DETAILED',
                locale: 'de',
                eventTypes: { STATUS: true, NEWS: true },
                interval: 60,
                createdAt: new Date('2020-01-01'),
            });
        }, 60000);

        test.each(LAYOUTS)('the %s layout is accepted by the API', async (layout) => {
            // Locally an EmbedBuilder validates the shape; only Discord decides whether it is
            // actually deliverable.
            await subscription.update({ layout });
            await nextCycle();

            const summary = await runCycle(client);
            expect(summary.failed).toBe(0);
            await track();

            const row = await models.Message.findOne({
                where: { subscriptionId: subscription.id, category: 'STATUS' },
            });
            expect(row).not.toBeNull();

            const message = await fetchFresh(row.messageId);
            expect(message.embeds).toHaveLength(1);
            expect(message.embeds[0].title.length).toBeGreaterThan(0);

            // Nothing a reader should ever see.
            const text = JSON.stringify(message.embeds[0].toJSON());
            expect(text).not.toMatch(/undefined|\[object Object\]|\bNaN\b/);
            expect(text).not.toMatch(/messages\.[a-z_]+\.[a-z_.]+/i);
        }, 180000);

        test('a second cycle edits nothing at all', async () => {
            // The dirty check is what keeps the bot under 50 requests a second. Measured here
            // on the real message rather than on a counter in a stub.
            const row = await models.Message.findOne({
                where: { subscriptionId: subscription.id, category: 'STATUS' },
            });
            const before = (await fetchFresh(row.messageId)).editedTimestamp;

            await nextCycle();
            await runCycle(client);

            const after = (await fetchFresh(row.messageId)).editedTimestamp;
            expect(after).toBe(before);
        }, 180000);

        test('the pause footer edits the message that is already there', async () => {
            // The path that reads a real Embed back out of Discord and writes it again — the
            // one place where messages.fetch and Read Message History actually matter.
            const { default: PauseManager, NOTIFY_AT_LEVEL } =
                await import('../../services/statuspagePauseManager.js');

            await page.reload();
            const before = await models.Message.count({ where: { category: 'STATUS' } });

            for (let i = 0; i < NOTIFY_AT_LEVEL; i += 1) {
                await PauseManager.handleFailure(page, new Error('fetch failed'), client, models);
            }

            // Nothing new was posted.
            expect(await models.Message.count({ where: { category: 'STATUS' } })).toBe(before);

            const row = await models.Message.findOne({
                where: { subscriptionId: subscription.id, category: 'STATUS' },
            });
            const message = await fetchFresh(row.messageId);

            expect(message.embeds[0].footer.text).toBe('inaktiv');
            // And everything else survived the edit.
            expect(message.embeds[0].title.length).toBeGreaterThan(0);
            expect(message.embeds[0].description || message.embeds[0].fields.length).toBeTruthy();
        }, 180000);

        test('and the next good cycle puts the name back, saying nothing', async () => {
            await page.reload();
            await page.update({
                paused: false, backoffLevel: 0, nextAttemptAt: null,
                failureCount: 0, pauseReason: null, kind: 'SELF_HOSTED',
            });

            const beforeCount = await models.Message.count({ where: { category: 'STATUS' } });

            await nextCycle();
            await runCycle(client);

            const row = await models.Message.findOne({
                where: { subscriptionId: subscription.id, category: 'STATUS' },
            });
            const message = await fetchFresh(row.messageId);

            expect(message.embeds[0].footer.text).not.toBe('inaktiv');
            // No "back online" message was posted — the edit is the whole signal.
            expect(await models.Message.count({ where: { category: 'STATUS' } })).toBe(beforeCount);
        }, 180000);
    });

    describe('a Cloud page', () => {
        test('is detected and rendered through the real API too', async () => {
            const page = await models.Statuspage.create({ url: PAGES[1].url, name: PAGES[1].name });
            await models.Subscription.create({
                guildId: credentials.TEST_GUILD_ID,
                channelId: credentials.TEST_CHANNEL_ID,
                statuspageId: page.id,
                layout: 'DETAILED',
                locale: 'en',
                eventTypes: { STATUS: true, NEWS: true },
                interval: 60,
                createdAt: new Date('2020-01-01'),
            });

            for (const row of await models.Statuspage.findAll()) {
                const cache = (await import('../../database/redis.js')).default;
                await cache.del(`dc-bot:statuspage:${row.id}`);
            }
            clearSnapshotCache();
            await runCycle(client);
            await track();
            await page.reload();

            expect(page.kind).toBe('CLOUD');
            expect(page.externalId).toEqual(expect.any(String));
        }, 180000);
    });

    describe('removing a thread', () => {
        test('the bot may delete its own messages with the four permissions it asks for', async () => {
            // THE ONE THING ONLY THE REAL API CAN ANSWER. When an alert is taken off a status
            // page the bot deletes the thread it posted, silently. Deleting someone ELSE's
            // message needs "Manage Messages", which is not in the 84992 this bot is invited
            // with — a bot deleting its OWN message is documented not to need it, and this is
            // where that stops being documentation and starts being measured.
            //
            // It also proves the order the production path uses: replies first, parent last,
            // so no reader ever sees "Original message was deleted" under a live thread.
            const parent = await channel.send({ content: 'e2e: alert parent' });
            const replies = [];
            for (const n of [1, 2]) {
                replies.push(await channel.send({
                    content: `e2e: alert update ${n}`,
                    reply: { messageReference: parent.id, failIfNotExists: false },
                }));
            }

            for (const reply of replies) {
                await channel.messages.delete(reply.id);
            }
            await channel.messages.delete(parent.id);

            for (const id of [...replies.map((r) => r.id), parent.id]) {
                await expect(fetchFresh(id)).rejects.toMatchObject({ code: 10008 });
            }
        }, 180000);

        test('deleting a message that is already gone is the 10008 the code treats as success', async () => {
            // `removeAlertThread` drops the row on 10008 rather than keeping a pointer to a
            // message nobody can see. That only holds if Discord really answers 10008.
            const message = await channel.send({ content: 'e2e: deleted twice' });
            await channel.messages.delete(message.id);

            await expect(channel.messages.delete(message.id)).rejects.toMatchObject({ code: 10008 });
        }, 180000);
    });

    describe('rate limiting', () => {
        test('a full cycle never trips an invalid-request warning', async () => {
            // ~10,000 invalid requests in 10 minutes gets the bot's IP banned at Cloudflare,
            // and discord.js is the only thing that can see it coming.
            const warnings = [];
            const rateLimits = [];
            client.rest.on('invalidRequestWarning', (info) => warnings.push(info));
            client.rest.on('rateLimited', (info) => rateLimits.push(info));

            for (const row of await models.Statuspage.findAll()) {
                const cache = (await import('../../database/redis.js')).default;
                await cache.del(`dc-bot:statuspage:${row.id}`);
            }
            clearSnapshotCache();
            await runCycle(client);

            expect(warnings).toHaveLength(0);
            expect(rateLimits.filter((info) => info.global)).toHaveLength(0);
        }, 180000);
    });
});
