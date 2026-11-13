/**
 * One simulated production: Discord, the status pages, a database, Redis keys, and the bot
 * process (or several, one after the other). A scenario builds the world, starts the bot, makes
 * things happen, and asks three questions:
 *
 *   converged  do the channels look exactly as the world says they must (harness/oracle.js)?
 *   quiet      with nothing changing, does the bot leave Discord alone?
 *   clean      did the referee in harness/discord.js see a single broken rule?
 *
 * Only runs with LIVCK_SIM=1 and a MariaDB and Redis it may use (see __tests__/sim/README.md).
 */

import { startSimDiscord } from './discord.js';
import { startSimPages } from './pages.js';
import { createDatabase, claimRedisDb, simEnv, migrate, startBot } from './bot.js';
import { differences } from './oracle.js';

export const enabled = process.env.LIVCK_SIM === '1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const createWorld = async ({ env: overrides = {}, discord: discordOptions = {} } = {}) => {
    const discord = await startSimDiscord(discordOptions);
    const pages = await startSimPages();
    const database = await createDatabase();
    const redisDb = await claimRedisDb();
    const env = simEnv({ discord, database, redisDb, overrides });
    await migrate({ env });

    /** Every page server: the shared one, and one per page that lives at a root URL. */
    const pageServers = [pages];
    const registry = {
        locate: (url) => pageServers.find((server) => server.owns(url)).locate(url),
    };
    /** slug → Statuspage row id */
    const pageRows = new Map();
    const bots = [];

    const world = {
        discord,
        pages,
        database,
        env,
        bots,

        guild: (options) => discord.addGuild(options),
        channel: (guildId, options) => discord.addChannel(guildId, options),
        page: (options) => pages.addPage(options),

        /**
         * A page on a server of its own, at the root — what a customer pastes into /livck subscribe.
         * @returns {{slug: string, url: string, pages: object}}
         */
        async rootPage(options) {
            const server = await startSimPages({ root: true });
            pageServers.push(server);
            const slug = server.addPage(options);
            return { slug, url: server.url(slug), pages: server };
        },

        /**
         * Subscribe a channel to a page, the way /livck subscribe leaves it in the database.
         * `since` is when it was created: incidents older than that are not posted.
         */
        async subscribe({ guild, channel, page, layout = 'DETAILED', locale = 'de', status = true, news = true, since = Date.now() - 3600_000 }) {
            if (!pageRows.has(page)) {
                const result = await database.query(
                    'INSERT INTO Statuspages (url, name, createdAt, updatedAt) VALUES (?, ?, NOW(), NOW())',
                    [pages.url(page), pages.page(page).name.de],
                );
                pageRows.set(page, result.insertId);
            }
            const result = await database.query(
                'INSERT INTO Subscriptions (guildId, channelId, statuspageId, eventTypes, `interval`, registeredAt, createdAt, updatedAt, locale, layout) '
                + 'VALUES (?, ?, ?, ?, 30, NOW(), ?, NOW(), ?, ?)',
                [guild, channel, pageRows.get(page), JSON.stringify({ STATUS: status, NEWS: news }), new Date(since), locale, layout],
            );
            return result.insertId;
        },

        async subscriptions() {
            return database.query(
                'SELECT s.id, s.guildId, s.channelId, s.locale, s.layout, s.eventTypes, s.createdAt, '
                + 'p.url, p.name, p.kind, p.externalId FROM Subscriptions s JOIN Statuspages p ON p.id = s.statuspageId',
            );
        },

        /** Start a bot process. `cwd` may be another checkout of the bot. */
        async start({ cwd = process.env.SIM_BOT_DIR || undefined, label = `bot${bots.length + 1}`, env: extra = {} } = {}) {
            const bot = startBot({ cwd, env: { ...env, ...extra }, label });
            bots.push(bot);
            await bot.waitFor(/Logged in as/, { timeout: 30_000 });
            return bot;
        },

        /** Where the channels differ from what the world says; empty when they do not. */
        async differences({ channels = null } = {}) {
            // A guild the bot is not in is frozen as far as the channels go; that it is left
            // alone is the referee's business (`not-a-member`), not the oracle's.
            const subscriptions = (await world.subscriptions()).filter((s) => discord.guild(s.guildId)?.member
                && !['hidden', 'deleted', 'readonly'].includes(discord.channel(s.channelId)?.access)
                && (!channels || channels.includes(s.channelId)));
            return differences({ discord, pages: registry, subscriptions });
        },

        /**
         * Wait until every channel is exactly right. Fails with the differences that remained,
         * and with every broken rule.
         */
        async converge({ timeout = 30_000, poll = 400, channels = null } = {}) {
            const started = Date.now();
            const deadline = started + timeout;
            let last = [];
            while (Date.now() < deadline) {
                last = await world.differences({ channels });
                if (last.length === 0) return Date.now() - started;
                await sleep(poll);
            }
            throw new Error(`Did not converge within ${timeout}ms:\n  ${last.slice(0, 30).join('\n  ')}`
                + (last.length > 30 ? `\n  … and ${last.length - 30} more` : '') + world.report());
        },

        /**
         * With nothing changing, `cycles` cycles may not send Discord a single request. `settle`
         * cycles go first: after a crash the new process resends, once, what it cannot know
         * arrived — that is a catch-up, and only what comes after it counts as noise.
         */
        async quiet(bot, cycles = 3, { settle = 0 } = {}) {
            if (settle > 0) await bot.cycles(settle);
            const since = Date.now();
            await bot.cycles(cycles);
            const requests = discord.requestsSince(since, (e) => e.channelId);
            if (requests.length > 0) {
                throw new Error(`Not quiet: ${requests.length} requests in ${cycles} unchanged cycles\n  `
                    + requests.slice(0, 10).map((e) => `${e.method} ${e.url} → ${e.status}`).join('\n  ') + world.report());
            }
        },

        /** The referee's verdict. */
        clean({ allow = [] } = {}) {
            const broken = discord.violations.filter((v) => !allow.includes(v.rule));
            if (broken.length > 0) {
                throw new Error(`${broken.length} broken rule(s):\n  `
                    + broken.slice(0, 20).map((v) => `${v.rule}: ${v.detail}`).join('\n  ') + world.report());
            }
        },

        report() {
            const bot = bots[bots.length - 1];
            const tail = bot ? bot.lines.slice(-15).map((l) => `    ${l.line}`).join('\n') : '';
            return `\n--- requests: ${discord.log.length}, invalid peak/10min: ${discord.invalidRequestPeak()}\n--- last bot lines (${bot?.label}):\n${tail}`;
        },

        async close() {
            for (const bot of bots) await bot.kill().catch(() => {});
            await discord.close().catch(() => {});
            for (const server of pageServers) await server.close().catch(() => {});
            await database.drop().catch(() => {});
        },
    };
    return world;
};

export default { createWorld, enabled };
