/**
 * End-to-end: the update loop itself.
 *
 * The loop is where the backoff, the pause manager and the Redis lock actually meet, and until
 * this file it was the one part of the bot that had never executed — it lived inside server.js
 * behind `await bot(models)`, so testing it required a Discord token. Extracting it into
 * services/updateLoop.js is what made this possible.
 *
 * Real database, real Redis, real network. Only Discord is recorded instead of called.
 *
 *   docker exec mariadb mariadb -u root -e "CREATE DATABASE IF NOT EXISTS livck_bot_e2e"
 *   DB_HOST=127.0.0.1 DB_DATABASE=livck_bot_e2e DB_USERNAME=root DB_PASSWORD= node migrate.js
 *   LIVCK_E2E=1 DB_HOST=127.0.0.1 DB_DATABASE=livck_bot_e2e DB_USERNAME=root DB_PASSWORD= \
 *     REDIS_HOST=127.0.0.1 REDIS_PORT=6379 npm test -- __tests__/e2e/updateLoop.live.test.js
 *
 * Never point it at a database you care about: it truncates every table it uses.
 */

import { createRequire } from 'module';

const deLang = createRequire(import.meta.url)('../../lang/de.json');

const e2e = process.env.LIVCK_E2E === '1' ? describe : describe.skip;

/** Reserved by RFC 6761 to never resolve, so the failure is DNS and never someone else's server. */
const DEAD_URL = 'https://livck-does-not-exist.invalid';
const SECOND_DEAD_URL = 'https://livck-also-does-not-exist.invalid';
const LIVE_URL = 'https://status.livck.com';
/** The page a recovered row is pointed at — a different product, so detection reruns too. */
const RECOVERY_URL = 'https://cloud.statuspage.de';

e2e('the update loop', () => {
    let models;
    let runCycle;
    let cache;
    let StatuspagePauseManager;
    let NOTIFY_AT_LEVEL;
    let BACKOFF_LADDER_MS;

    /** Everything the bot would have sent, per channel. */
    let sent = [];

    /** Channel ids Discord refuses, mapped to the error code it answers with. */
    const refused = new Map();

    const client = {
        channels: {
            fetch: async (id) => {
                if (refused.has(id)) {
                    throw Object.assign(new Error(`refused ${id}`), { code: refused.get(id) });
                }
                return {
                    id,
                    send: async (payload) => { sent.push({ channelId: id, payload }); return { id: `msg-${sent.length}` }; },
                    messages: { edit: async (_id, payload) => { sent.push({ channelId: id, edit: true, payload }); return {}; } },
                };
            },
        },
    };

    /** Text of every embed sent so far, flattened, so assertions read like the channel does. */
    const textOf = () => sent.flatMap(({ payload }) =>
        (payload.embeds ?? []).map((e) => {
            const json = typeof e.toJSON === 'function' ? e.toJSON() : e;
            return `${json.title ?? ''}\n${json.description ?? ''}`;
        })
    );

    const seed = async (url, name) => models.Statuspage.create({ url, name });

    const subscribe = async (statuspageId, channelId) => models.Subscription.create({
        guildId: 'loop-guild',
        channelId,
        statuspageId,
        layout: 'COMPACT',
        locale: 'de',
        eventTypes: { STATUS: true, NEWS: true },
        interval: 60,
        createdAt: new Date('2020-01-01'),
    });

    /**
     * Pretend the backoff window elapsed. Advancing the clock is the only thing a test cannot
     * do honestly here — waiting out the real ladder would take 21 minutes.
     */
    const expireBackoff = async (row) => {
        await row.reload();
        if (row.nextAttemptAt) await row.update({ nextAttemptAt: new Date(Date.now() - 1000) });
    };

    /** The Redis lock is a real 20s key; a test that wants a fresh cycle has to drop it. */
    const dropLock = async (id) => cache.del(`dc-bot:statuspage:${id}`);

    beforeAll(async () => {
        models = (await import('../../models/index.js')).default;
        ({ runCycle } = await import('../../services/updateLoop.js'));
        cache = (await import('../../database/redis.js')).default;
        ({ default: StatuspagePauseManager, NOTIFY_AT_LEVEL, BACKOFF_LADDER_MS } =
            await import('../../services/statuspagePauseManager.js'));

        await models.Message.destroy({ where: {}, truncate: true, cascade: true });
        await models.CustomLink.destroy({ where: {}, truncate: true, cascade: true });
        await models.RoleMention.destroy({ where: {}, truncate: true, cascade: true });
        await models.Subscription.destroy({ where: {} });
        await models.Statuspage.destroy({ where: {} });
    }, 60000);

    afterAll(async () => {
        if (models) await models.database.close();
        if (cache?.isOpen) await cache.quit();
    });

    beforeEach(() => { sent = []; });

    describe('a page that answers', () => {
        let page;

        beforeAll(async () => {
            page = await seed(LIVE_URL, 'status.livck.com');
            await subscribe(page.id, 'loop-live');
        }, 60000);

        test('is processed, detected and posted in the first cycle', async () => {
            await dropLock(page.id);
            const summary = await runCycle(client);

            expect(summary.updated).toBeGreaterThanOrEqual(1);
            expect(summary.failed).toBe(0);

            await page.reload();
            expect(page.kind).toBe('SELF_HOSTED');
            expect(sent.filter((m) => m.channelId === 'loop-live')).toHaveLength(1);
        }, 120000);

        test('is skipped by the Redis lock in the cycle right after', async () => {
            // Two overlapping cycles must not both do the work; the lock is what prevents it.
            const summary = await runCycle(client);

            expect(summary.skipped).toBeGreaterThanOrEqual(1);
            expect(sent).toHaveLength(0);
        }, 120000);

        test('sends nothing once the lock expires, because nothing changed', async () => {
            await dropLock(page.id);
            const summary = await runCycle(client);

            expect(summary.updated).toBeGreaterThanOrEqual(1);
            expect(sent).toHaveLength(0);
        }, 120000);
    });

    describe('a page that does not resolve', () => {
        let dead;

        beforeAll(async () => {
            dead = await seed(DEAD_URL, 'dead.invalid');
            await subscribe(dead.id, 'loop-dead');
        }, 60000);

        test('climbs one rung per cycle and is quiet until the threshold', async () => {
            for (let level = 1; level < NOTIFY_AT_LEVEL; level += 1) {
                await dropLock(dead.id);
                await expireBackoff(dead);
                await runCycle(client);
                await dead.reload();

                expect(dead.backoffLevel).toBe(level);
                expect(dead.failureCount).toBe(level);
                expect(dead.paused).toBe(false);
                expect(dead.pauseReason).toBe('DNS');
                expect(new Date(dead.nextAttemptAt).getTime())
                    .toBeGreaterThan(Date.now() + BACKOFF_LADDER_MS[level - 1] - 5000);
            }

            // Nothing was said to the channel on the way up: a blip must not page anyone.
            expect(sent.filter((m) => m.channelId === 'loop-dead')).toHaveLength(0);
        }, 180000);

        test('is not even loaded while its penalty is still running', async () => {
            // Backoff is enforced in the WHERE clause; a few hundred dead pages must cost
            // nothing per cycle, not one request each.
            await dropLock(dead.id);
            await dead.reload();
            const before = { level: dead.backoffLevel, count: dead.failureCount };

            await runCycle(client);
            await dead.reload();

            expect(dead.backoffLevel).toBe(before.level);
            expect(dead.failureCount).toBe(before.count);
        }, 60000);

        test('tells the subscribers exactly once when it crosses the threshold', async () => {
            await dropLock(dead.id);
            await expireBackoff(dead);
            const summary = await runCycle(client);

            expect(summary.announced).toBe(1);

            await dead.reload();
            expect(dead.backoffLevel).toBe(NOTIFY_AT_LEVEL);
            expect(dead.paused).toBe(true);

            const notices = sent.filter((m) => m.channelId === 'loop-dead');
            expect(notices).toHaveLength(1);

            const text = textOf().join('\n');
            expect(text).toContain('dead.invalid');
            // A key instead of a sentence is the most visible way i18n breaks here.
            expect(text).not.toMatch(/messages\.pause\./);

            // And it must name the ACTUAL cause. This is what the bug looked like from a
            // customer's channel: a DNS outage was announced as "no longer a LIVCK status
            // page", which reads as "you broke your own status page".
            expect(text).toContain(deLang.messages.pause.reason.DNS);
            expect(text).not.toContain(deLang.messages.pause.reason.NOT_LIVCK);
        }, 60000);

        test('does not repeat itself on the cycles after', async () => {
            for (let i = 0; i < 2; i += 1) {
                await dropLock(dead.id);
                await expireBackoff(dead);
                await runCycle(client);
            }

            expect(sent.filter((m) => m.channelId === 'loop-dead')).toHaveLength(0);

            await dead.reload();
            expect(dead.paused).toBe(true);
        }, 120000);

        test('settles at the top rung instead of growing without bound', async () => {
            await dead.reload();
            while (dead.backoffLevel < BACKOFF_LADDER_MS.length + 2) {
                await dropLock(dead.id);
                await expireBackoff(dead);
                await runCycle(client);
                await dead.reload();
                if (dead.backoffLevel === BACKOFF_LADDER_MS.length) break;
            }

            expect(dead.backoffLevel).toBe(BACKOFF_LADDER_MS.length);

            await dropLock(dead.id);
            await expireBackoff(dead);
            await runCycle(client);
            await dead.reload();

            // Still capped, and the wait is the top rung — 4 requests a day, not 5760.
            expect(dead.backoffLevel).toBe(BACKOFF_LADDER_MS.length);
            expect(new Date(dead.nextAttemptAt).getTime())
                .toBeGreaterThan(Date.now() + BACKOFF_LADDER_MS.at(-1) - 5000);
        }, 180000);

        test('comes back by itself, and says so, as soon as it answers', async () => {
            // No human, no `/livck resume`: the page recovers on its own next successful cycle.
            await dead.update({ url: RECOVERY_URL, kind: null, externalId: null });
            await dropLock(dead.id);
            await expireBackoff(dead);

            const summary = await runCycle(client);
            expect(summary.failed).toBe(0);

            await dead.reload();
            expect(dead.paused).toBe(false);
            expect(dead.pauseReason).toBeNull();
            expect(dead.backoffLevel).toBe(0);
            expect(dead.failureCount).toBe(0);
            expect(dead.nextAttemptAt).toBeNull();

            const notices = sent.filter((m) => m.channelId === 'loop-dead');
            // The resume notice, plus the status message this channel never got while dead.
            expect(notices.length).toBeGreaterThanOrEqual(1);
            expect(textOf().join('\n')).not.toMatch(/messages\.(pause|resume)\./);
        }, 120000);
    });

    describe('a channel the bot may not post in', () => {
        test('does not pause the status page for everybody else', async () => {
            // The failure that is NOT the status page's fault. One guild revoking "Send
            // Messages" used to escape the handler, advance the page's backoff and — four
            // cycles later — announce "unreachable" in every OTHER guild watching that page.
            const page = await seed('https://fc-status.net', 'fc-status.net');
            await subscribe(page.id, 'loop-refused');
            await subscribe(page.id, 'loop-allowed');
            refused.set('loop-refused', 50013);

            try {
                await dropLock(page.id);
                await runCycle(client);
                await page.reload();

                expect(page.backoffLevel).toBe(0);
                expect(page.failureCount).toBe(0);
                expect(page.paused).toBe(false);
                expect(page.nextAttemptAt).toBeNull();

                // And the healthy channel in the same guild still got its update.
                expect(sent.filter((m) => m.channelId === 'loop-allowed')).toHaveLength(1);
            } finally {
                refused.clear();
            }
        }, 120000);
    });

    describe('one broken page among healthy ones', () => {
        test('does not stop the others from being processed', async () => {
            // Promise.allSettled, not Promise.all: a single dead domain must not take the
            // whole cycle down with it.
            const broken = await seed(SECOND_DEAD_URL, 'second-dead.invalid');
            await subscribe(broken.id, 'loop-dead-2');

            for (const row of await models.Statuspage.findAll()) {
                await dropLock(row.id);
                if (row.nextAttemptAt) await row.update({ nextAttemptAt: new Date(Date.now() - 1000) });
            }

            const summary = await runCycle(client);

            expect(summary.failed).toBe(1);
            expect(summary.updated).toBe(summary.due - 1);
        }, 120000);
    });
});
