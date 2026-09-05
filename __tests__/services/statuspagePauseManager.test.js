/**
 * The backoff ladder is what stops the bot hammering — and spamming the log about — a status
 * page that is simply gone. These tests pin the behaviour that was broken before Phase 0:
 * the counter advancing at all, and subscribers being told exactly once.
 */

import { jest } from '@jest/globals';

// database/redis.js opens a connection on import; the manager only needs it for the manual
// `/livck resume` cooldown, so it is stubbed out here.
jest.unstable_mockModule('../../database/redis.js', () => ({
    default: {
        get: jest.fn(async () => null),
        set: jest.fn(async () => 'OK'),
    },
}));

const { default: StatuspagePauseManager, BACKOFF_LADDER_MS, NOTIFY_AT_LEVEL, backoffDelay } =
    await import('../../services/statuspagePauseManager.js');
const { FAILURE_KINDS, HttpError } = await import('../../util/errors.js');
const { default: cache } = await import('../../database/redis.js');

/** Statuspage row stand-in that records saves, like the loaded Sequelize instance. */
const makeStatuspage = (overrides = {}) => {
    const row = {
        id: 42,
        url: 'https://status.example.com',
        name: 'Example',
        paused: false,
        pauseReason: null,
        failureCount: 0,
        lastFailure: null,
        backoffLevel: 0,
        nextAttemptAt: null,
        saves: 0,
        save: async () => { row.saves += 1; },
        ...overrides,
    };
    return row;
};

/**
 * A pause NEVER posts anything. It edits the footer of the status message that is already in
 * the channel — so `sent` must stay empty for ever, and `edits` is what carries the signal.
 */
const makeContext = () => {
    const sent = [];
    const edits = [];

    const existing = (id) => ({
        embeds: [{ toJSON: () => ({ title: 'Dienste von Example', description: 'alles gut', footer: { text: 'Example' } }) }],
        components: [],
        id,
    });

    const client = {
        channels: {
            fetch: async (id) => ({
                id,
                send: async (msg) => { sent.push({ id, msg }); },
                messages: {
                    fetch: async (messageId) => existing(messageId),
                    edit: async (messageId, payload) => { edits.push({ channelId: id, messageId, payload }); return {}; },
                },
            }),
        },
    };

    const models = {
        Subscription: {
            findAll: async () => [
                { id: 1, channelId: 'c1', locale: 'de' },
                { id: 2, channelId: 'c2', locale: 'en' },
            ],
        },
        Message: {
            findOne: async ({ where }) => ({ id: where.subscriptionId, messageId: `msg-${where.subscriptionId}` }),
            update: async () => [1],
        },
    };

    return { client, models, sent, edits };
};

/** The footer note, in one of the two languages. */
const footerNote = /nicht erreichbar|unreachable/;

describe('backoffDelay', () => {
    test('level 1 is the shortest rung', () => {
        expect(backoffDelay(1)).toBe(BACKOFF_LADDER_MS[0]);
    });

    test('the ladder only ever grows', () => {
        for (let i = 1; i < BACKOFF_LADDER_MS.length; i += 1) {
            expect(BACKOFF_LADDER_MS[i]).toBeGreaterThan(BACKOFF_LADDER_MS[i - 1]);
        }
    });

    test('levels beyond the ladder clamp to the top rung', () => {
        const top = BACKOFF_LADDER_MS.at(-1);
        expect(backoffDelay(BACKOFF_LADDER_MS.length)).toBe(top);
        expect(backoffDelay(999)).toBe(top);
    });
});

describe('handleFailure', () => {
    test('advances the level and schedules the next attempt', async () => {
        const page = makeStatuspage();
        const { client, models } = makeContext();

        const before = Date.now();
        const result = await StatuspagePauseManager.handleFailure(
            page, new HttpError(503, 'Service Unavailable'), client, models
        );

        expect(result.level).toBe(1);
        expect(page.backoffLevel).toBe(1);
        expect(page.failureCount).toBe(1);
        expect(page.pauseReason).toBe(FAILURE_KINDS.HTTP_5XX);
        expect(page.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + BACKOFF_LADDER_MS[0]);
        expect(page.saves).toBe(1);
    });

    test('the counter actually increments across cycles', async () => {
        // The regression this whole file exists for: server.js used to select only four
        // columns, so backoffLevel was undefined, `undefined + 1` was NaN, and the threshold
        // could never be reached.
        const page = makeStatuspage();
        const { client, models } = makeContext();

        for (let i = 1; i <= 3; i += 1) {
            await StatuspagePauseManager.handleFailure(page, new Error('fetch failed'), client, models);
            expect(page.backoffLevel).toBe(i);
            expect(Number.isNaN(page.backoffLevel)).toBe(false);
        }
    });

    test('the level never exceeds the ladder', async () => {
        const page = makeStatuspage();
        const { client, models } = makeContext();

        for (let i = 0; i < 20; i += 1) {
            await StatuspagePauseManager.handleFailure(page, new Error('fetch failed'), client, models);
        }

        expect(page.backoffLevel).toBe(BACKOFF_LADDER_MS.length);
    });

    test('the existing message gains a footer note, and nothing is posted', async () => {
        // An outage is the absence of news, not news. It used to post its own embed into
        // every subscribed channel, and the recovery posted another one — two notifications
        // per channel per outage, about something nobody asked to be told.
        const page = makeStatuspage();
        const { client, models, sent, edits } = makeContext();

        for (let i = 0; i < NOTIFY_AT_LEVEL; i += 1) {
            await StatuspagePauseManager.handleFailure(page, new Error('fetch failed'), client, models);
        }

        expect(page.paused).toBe(true);
        expect(sent).toHaveLength(0);
        expect(edits).toHaveLength(2); // one per subscribed channel

        for (const { payload } of edits) {
            const footer = payload.embeds[0].footer.text;
            expect(footer.startsWith('Example')).toBe(true);
            expect(footer).toMatch(footerNote);
            // The message keeps everything it was showing.
            expect(payload.embeds[0].description).toBe('alles gut');
        }
    });

    test('the note names the real cause', async () => {
        const page = makeStatuspage();
        const { client, models, edits } = makeContext();

        const dns = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
        for (let i = 0; i < NOTIFY_AT_LEVEL; i += 1) {
            await StatuspagePauseManager.handleFailure(page, dns, client, models);
        }

        expect(edits[0].payload.embeds[0].footer.text).toContain('Domain nicht auflösbar');
    });

    test('the footer is not annotated twice on a later failure', async () => {
        const page = makeStatuspage();
        const { client, models, sent, edits } = makeContext();

        for (let i = 0; i < NOTIFY_AT_LEVEL + 6; i += 1) {
            await StatuspagePauseManager.handleFailure(page, new Error('fetch failed'), client, models);
        }

        expect(sent).toHaveLength(0);
        expect(edits).toHaveLength(2);
    });

    test('nothing at all happens before the threshold', async () => {
        const page = makeStatuspage();
        const { client, models, sent, edits } = makeContext();

        for (let i = 0; i < NOTIFY_AT_LEVEL - 1; i += 1) {
            await StatuspagePauseManager.handleFailure(page, new Error('fetch failed'), client, models);
        }

        expect(page.paused).toBe(false);
        expect(sent).toHaveLength(0);
        expect(edits).toHaveLength(0);
    });

    test('the reason reflects the actual failure', async () => {
        const { client, models } = makeContext();

        const dns = makeStatuspage();
        const error = new Error('fetch failed');
        error.cause = { code: 'ENOTFOUND' };
        await StatuspagePauseManager.handleFailure(dns, error, client, models);
        expect(dns.pauseReason).toBe(FAILURE_KINDS.DNS);

        const notFound = makeStatuspage();
        await StatuspagePauseManager.handleFailure(notFound, new HttpError(404, 'Not Found'), client, models);
        expect(notFound.pauseReason).toBe(FAILURE_KINDS.HTTP_4XX);
    });

    test('works without a Discord client', async () => {
        const page = makeStatuspage();
        await expect(
            StatuspagePauseManager.handleFailure(page, new Error('fetch failed'), null, null)
        ).resolves.toBeDefined();
        expect(page.backoffLevel).toBe(1);
    });
});

describe('handleSuccess', () => {
    test('a healthy page is not written to on every cycle', async () => {
        const page = makeStatuspage();
        const { client, models } = makeContext();

        await StatuspagePauseManager.handleSuccess(page, client, models);

        expect(page.saves).toBe(0);
    });

    test('clears the backoff after a failure', async () => {
        const page = makeStatuspage({ backoffLevel: 2, failureCount: 2, nextAttemptAt: new Date(), pauseReason: 'DNS' });
        const { client, models } = makeContext();

        await StatuspagePauseManager.handleSuccess(page, client, models);

        expect(page.backoffLevel).toBe(0);
        expect(page.failureCount).toBe(0);
        expect(page.nextAttemptAt).toBeNull();
        expect(page.pauseReason).toBeNull();
    });

    test('coming back says nothing either', async () => {
        // There is no "back online" message. The next render simply produces the page's real
        // content again, footer included, and that edit is the whole signal.
        const page = makeStatuspage({ paused: true, backoffLevel: 5, pauseReason: 'DNS' });
        const { client, models, sent, edits } = makeContext();

        const recovered = await StatuspagePauseManager.handleSuccess(page, client, models);

        expect(recovered).toBe(true);
        expect(page.paused).toBe(false);
        expect(sent).toHaveLength(0);
        expect(edits).toHaveLength(0);
    });

    test('recovering from a silent backoff is silent too', async () => {
        const page = makeStatuspage({ backoffLevel: 2, failureCount: 2 });
        const { client, models, sent } = makeContext();

        expect(await StatuspagePauseManager.handleSuccess(page, client, models)).toBe(false);
        expect(sent).toHaveLength(0);
    });
});

describe('resume', () => {
    beforeEach(() => {
        cache.get.mockResolvedValue(null);
        cache.set.mockClear();
    });

    test('clears the backoff so the next cycle retries at once', async () => {
        const page = makeStatuspage({ paused: true, backoffLevel: 5, pauseReason: 'DNS', nextAttemptAt: new Date(Date.now() + 3600e3) });

        const result = await StatuspagePauseManager.resume(page);

        expect(result.success).toBe(true);
        expect(page.paused).toBe(false);
        expect(page.backoffLevel).toBe(0);
        expect(page.nextAttemptAt).toBeNull();
    });

    test('works for a page that is backing off but was never announced', async () => {
        const page = makeStatuspage({ paused: false, backoffLevel: 2, nextAttemptAt: new Date() });

        await expect(StatuspagePauseManager.resume(page)).resolves.toMatchObject({ success: true });
    });

    test('refuses when there is nothing to resume, without touching the row', async () => {
        const page = makeStatuspage();

        const result = await StatuspagePauseManager.resume(page);

        expect(result.success).toBe(false);
        expect(page.saves).toBe(0);
    });

    test('is rate limited to one attempt per cooldown', async () => {
        cache.get.mockResolvedValue(String(Date.now()));
        const page = makeStatuspage({ paused: true, backoffLevel: 5 });

        const result = await StatuspagePauseManager.resume(page);

        expect(result.success).toBe(false);
        expect(result.rateLimited).toBe(true);
        expect(result.remainingSeconds).toBeGreaterThan(0);
        expect(page.paused).toBe(true); // unchanged
    });

    test('records the cooldown after a successful resume', async () => {
        await StatuspagePauseManager.resume(makeStatuspage({ paused: true, backoffLevel: 5 }));

        expect(cache.set).toHaveBeenCalled();
    });
});

describe('getPausedForGuild', () => {
    test('asks only for announced-paused pages of that guild', async () => {
        let query;
        const models = { Statuspage: { findAll: async (q) => { query = q; return []; } } };

        await StatuspagePauseManager.getPausedForGuild(models, 'guild-1');

        expect(query.where).toEqual({ paused: true });
        expect(query.include[0].where).toEqual({ guildId: 'guild-1' });
        expect(query.include[0].required).toBe(true);
    });
});

describe('shouldSkip', () => {
    const now = Date.now();

    test('a page with no schedule is due', () => {
        expect(StatuspagePauseManager.shouldSkip(makeStatuspage(), now)).toBe(false);
    });

    test('a page still serving its penalty is skipped', () => {
        const page = makeStatuspage({ nextAttemptAt: new Date(now + 60_000) });
        expect(StatuspagePauseManager.shouldSkip(page, now)).toBe(true);
    });

    test('a page whose penalty elapsed is due again', () => {
        const page = makeStatuspage({ nextAttemptAt: new Date(now - 1000) });
        expect(StatuspagePauseManager.shouldSkip(page, now)).toBe(false);
    });
});
