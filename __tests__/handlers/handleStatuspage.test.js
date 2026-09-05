/**
 * Behaviour of the status handler, which Phase 0 rewrote almost completely.
 *
 * The interesting cases are not "does it render" — the golden test covers that — but what it
 * does around the render: how often it calls Discord, what happens when a fetch fails, and
 * when it is allowed to delete a subscription.
 */

import { jest } from '@jest/globals';

/** Controls what the stubbed LIVCK client returns, per test. */
const api = {
    responses: {},
    calls: [],
};

jest.unstable_mockModule('../../api/livck.js', () => ({
    default: class MockLIVCK {
        constructor(baseUrl, version, token, locale) {
            this.baseURL = baseUrl;
            this.token = token;
            this.locale = locale;
        }

        async get(path) {
            api.calls.push({ path, token: this.token, locale: this.locale });
            const value = api.responses[path] ?? api.responses.default;
            if (value instanceof Error) throw value;
            return value ?? { data: [] };
        }
    },
}));

const db = {};

jest.unstable_mockModule('../../models/index.js', () => ({
    default: {
        Statuspage: { findOne: async () => db.statuspage },
        Subscription: { destroy: async ({ where }) => { db.destroyed.push(where.id); } },
        CustomLink: { findAll: async () => db.customLinks },
        Message: {
            findOne: async ({ where }) => db.messages.find(
                (m) => m.subscriptionId === where.subscriptionId && m.category === where.category
            ) ?? null,
            // Query-level update: the production code cannot use record.update() for the
            // heartbeat, because Sequelize issues no SQL when nothing changed and updatedAt
            // would never move.
            update: async (values, { where }) => {
                const row = db.messages.find((m) => m.id === where.id);
                if (row) { Object.assign(row, values); row.updatedAt = new Date(); }
                return [row ? 1 : 0];
            },
            create: async (row) => {
                // Behaves like a Sequelize instance: update() persists and bumps updatedAt,
                // which is what the dirty check and the heartbeat both read back.
                const record = {
                    ...row,
                    updatedAt: new Date(),
                    update: async (fields) => { Object.assign(record, fields); record.updatedAt = new Date(); },
                    destroy: async () => { db.messages = db.messages.filter((m) => m !== record); },
                };
                db.messages.push(record);
                return record;
            },
        },
    },
}));

const { handleStatusPage } = await import('../../handlers/handleStatuspage.js');
const { HttpError } = await import('../../util/errors.js');
const { clearSnapshotCache } = await import('../../providers/index.js');

/**
 * Simulate the gap between two update cycles.
 *
 * The provider memoizes a snapshot for a few seconds so handleStatusPage and handleAlerts —
 * which run concurrently for the same page — share one fetch. Real cycles are 15s apart and
 * outlive that window; a test calling the handler twice in a millisecond does not, so the
 * memo has to be retired explicitly.
 */
const nextCycle = () => clearSnapshotCache();

const discord = {
    sends: 0, edits: 0, fetches: 0, lastPayload: null, channelError: null,
    /** Which channels the error applies to; null means all of them. */
    failChannels: null,
    /** Channel ids that actually received something. */
    sentTo: [],
};

const makeClient = () => ({
    channels: {
        fetch: async (id) => {
            if (discord.channelError && (!discord.failChannels || discord.failChannels.has(id))) {
                throw discord.channelError;
            }
            return {
                id,
                send: async (payload) => { discord.sends += 1; discord.sentTo.push(id); discord.lastPayload = payload; return { id: `msg-${discord.sends}` }; },
                messages: {
                    edit: async (_id, payload) => { discord.edits += 1; discord.lastPayload = payload; return {}; },
                    fetch: async () => { discord.fetches += 1; return {}; },
                },
            };
        },
    },
});

const subscription = (overrides = {}) => ({
    id: 1,
    channelId: 'chan-1',
    locale: 'de',
    layout: 'DETAILED',
    apiToken: null,
    eventTypes: { STATUS: true, NEWS: false },
    createdAt: new Date('2020-01-01'),
    ...overrides,
});

const categoriesResponse = (state = 'AVAILABLE') => ({
    'cat-1': { id: 'cat-1', name: 'Platform' },
    _state: state,
});

beforeEach(() => {
    api.responses = {
        categories: { 'cat-1': { id: 'cat-1', name: 'Platform' } },
        'category/cat-1/monitors': { data: [{ id: 'm1', name: 'API', state: 'AVAILABLE' }] },
        alerts: { data: [] },
    };
    api.calls = [];

    db.statuspage = {
        id: 7,
        url: 'https://status.example.com',
        name: 'Example',
        // Pre-detected, so the provider registry does not probe the network here. The
        // detection path itself is covered in __tests__/api/detect.test.js.
        kind: 'SELF_HOSTED',
        externalId: null,
        save: async () => {},
        Subscriptions: [subscription()],
    };
    db.messages = [];
    db.customLinks = [];
    db.destroyed = [];

    clearSnapshotCache();

    discord.failChannels = null;
    discord.sentTo = [];
    discord.sends = 0;
    discord.edits = 0;
    discord.fetches = 0;
    discord.lastPayload = null;
    discord.channelError = null;
});

describe('first delivery', () => {
    test('posts a message and records it', async () => {
        await handleStatusPage(7, makeClient());

        expect(discord.sends).toBe(1);
        expect(db.messages).toHaveLength(1);
        expect(db.messages[0].contentHash).toEqual(expect.any(String));
    });

    test('does nothing for a subscription that opted out of STATUS', async () => {
        db.statuspage.Subscriptions = [subscription({ eventTypes: { STATUS: false, NEWS: true } })];

        await handleStatusPage(7, makeClient());

        expect(discord.sends).toBe(0);
    });

    test('an unknown statuspage id is a no-op', async () => {
        db.statuspage = null;
        await expect(handleStatusPage(999, makeClient())).resolves.toBeUndefined();
    });
});

describe('subsequent cycles', () => {
    test('an unchanged status is not re-sent to Discord', async () => {
        const client = makeClient();
        await handleStatusPage(7, client);
        const afterFirst = { sends: discord.sends, edits: discord.edits };

        nextCycle();
        await handleStatusPage(7, client);

        expect(discord.sends).toBe(afterFirst.sends);
        expect(discord.edits).toBe(afterFirst.edits);
    });

    test('a changed status is edited', async () => {
        const client = makeClient();
        await handleStatusPage(7, client);

        api.responses['category/cat-1/monitors'] = { data: [{ id: 'm1', name: 'API', state: 'UNAVAILABLE' }] };
        nextCycle();
        await handleStatusPage(7, client);

        expect(discord.edits).toBe(1);
    });

    test('settles back to zero traffic after a change', async () => {
        // The whole point of the dirty check: an outage costs one edit, not one per cycle
        // for as long as it lasts.
        const client = makeClient();
        await handleStatusPage(7, client);

        api.responses['category/cat-1/monitors'] = { data: [{ id: 'm1', name: 'API', state: 'UNAVAILABLE' }] };
        nextCycle();
        await handleStatusPage(7, client);
        expect(discord.edits).toBe(1);

        for (let cycle = 0; cycle < 10; cycle += 1) {
            nextCycle();
            await handleStatusPage(7, client);
        }

        expect(discord.edits).toBe(1);
    });

    test('the stored hash follows the content', async () => {
        const client = makeClient();
        await handleStatusPage(7, client);
        const first = db.messages[0].contentHash;

        api.responses['category/cat-1/monitors'] = { data: [{ id: 'm1', name: 'API', state: 'UNAVAILABLE' }] };
        nextCycle();
        await handleStatusPage(7, client);

        expect(db.messages[0].contentHash).not.toBe(first);
    });

    test('the message is never fetched before being edited', async () => {
        // Two REST calls per subscription per cycle was the old behaviour and the reason the
        // bot capped out near 375 subscriptions against Discord's 50 req/s budget.
        const client = makeClient();
        await handleStatusPage(7, client);

        api.responses['category/cat-1/monitors'] = { data: [{ id: 'm1', name: 'API', state: 'UNAVAILABLE' }] };
        nextCycle();
        await handleStatusPage(7, client);

        expect(discord.fetches).toBe(0);
    });
});

describe('fetch failures', () => {
    test('throws when every group failed, so the loop can back off', async () => {
        api.responses.categories = new HttpError(503, 'Service Unavailable');

        await expect(handleStatusPage(7, makeClient())).rejects.toMatchObject({ status: 503 });
    });

    test('leaves the existing message untouched when the fetch fails', async () => {
        // Publishing an empty render would replace a good status embed with "no categories
        // available" on every transient network hiccup.
        const client = makeClient();
        await handleStatusPage(7, client);
        const sendsBefore = discord.sends;

        api.responses.categories = new HttpError(500, 'Server Error');
        await handleStatusPage(7, client).catch(() => {});

        expect(discord.edits).toBe(0);
        expect(discord.sends).toBe(sendsBefore);
    });

    test('does not throw when at least one group succeeded', async () => {
        // A single subscription with a bad API token must not take the whole page down.
        db.statuspage.Subscriptions = [
            subscription({ id: 1, apiToken: null }),
            subscription({ id: 2, channelId: 'chan-2', apiToken: 'bad-token' }),
        ];

        const { default: MockLIVCK } = await import('../../api/livck.js');
        const original = MockLIVCK.prototype.get;
        MockLIVCK.prototype.get = async function get(path) {
            if (this.token === 'bad-token') throw new HttpError(403, 'Forbidden');
            return original.call(this, path);
        };

        await expect(handleStatusPage(7, makeClient())).resolves.toBeUndefined();

        MockLIVCK.prototype.get = original;
    });
});

describe('subscription grouping', () => {
    test('one fetch serves every subscription sharing token and locale', async () => {
        db.statuspage.Subscriptions = [
            subscription({ id: 1, channelId: 'c1' }),
            subscription({ id: 2, channelId: 'c2' }),
            subscription({ id: 3, channelId: 'c3' }),
        ];

        await handleStatusPage(7, makeClient());

        expect(api.calls.filter((c) => c.path === 'categories')).toHaveLength(1);
        expect(discord.sends).toBe(3);
    });

    test('different locales are fetched separately', async () => {
        db.statuspage.Subscriptions = [
            subscription({ id: 1, channelId: 'c1', locale: 'de' }),
            subscription({ id: 2, channelId: 'c2', locale: 'en' }),
        ];

        await handleStatusPage(7, makeClient());

        const locales = api.calls.filter((c) => c.path === 'categories').map((c) => c.locale);
        expect(locales.sort()).toEqual(['de', 'en']);
    });
});

describe('custom link buttons', () => {
    const link = (overrides = {}) => ({
        id: 1, label: 'Website', url: 'https://example.com', emoji: null, position: 0, ...overrides,
    });

    test('links become link-style buttons', async () => {
        db.customLinks = [link()];

        await handleStatusPage(7, makeClient());

        const row = discord.lastPayload.components[0].toJSON();
        expect(row.components[0]).toMatchObject({ label: 'Website', url: 'https://example.com', style: 5 });
    });

    test('buttons are chunked five per row', async () => {
        db.customLinks = Array.from({ length: 7 }, (_, i) => link({ id: i, label: `L${i}` }));

        await handleStatusPage(7, makeClient());

        const rows = discord.lastPayload.components.map((r) => r.toJSON().components.length);
        expect(rows).toEqual([5, 2]);
    });

    test('never more than 25 buttons', async () => {
        db.customLinks = Array.from({ length: 40 }, (_, i) => link({ id: i, label: `L${i}` }));

        await handleStatusPage(7, makeClient());

        const total = discord.lastPayload.components
            .reduce((sum, r) => sum + r.toJSON().components.length, 0);
        expect(total).toBe(25);
        expect(discord.lastPayload.components).toHaveLength(5);
    });

    test('a Discord shortcode is dropped rather than rejected by the API', async () => {
        // `:zap:` is not a valid button emoji; sending it makes Discord reject the whole
        // message, so the status update would silently stop appearing.
        db.customLinks = [link({ emoji: ':zap:' })];

        await handleStatusPage(7, makeClient());

        expect(discord.lastPayload.components[0].toJSON().components[0].emoji).toBeUndefined();
    });

    test('unicode and custom emojis are kept', async () => {
        db.customLinks = [link({ id: 1, emoji: '🔥' }), link({ id: 2, emoji: '<:live:123>' })];

        await handleStatusPage(7, makeClient());

        const buttons = discord.lastPayload.components[0].toJSON().components;
        expect(buttons[0].emoji).toBeDefined();
        expect(buttons[1].emoji).toBeDefined();
    });

    test('no links means no component rows', async () => {
        await handleStatusPage(7, makeClient());
        expect(discord.lastPayload.components).toEqual([]);
    });

    test('changing a link changes the message', async () => {
        // Buttons are part of the payload hash, so editing a link must reach Discord.
        const client = makeClient();
        db.customLinks = [link()];
        await handleStatusPage(7, client);

        db.customLinks = [link({ label: 'Neue Website' })];
        nextCycle();
        await handleStatusPage(7, client);

        expect(discord.edits).toBe(1);
    });
});

describe('channel problems', () => {
    test('a deleted channel removes the subscription', async () => {
        const error = new Error('Unknown Channel');
        error.code = 10003;
        discord.channelError = error;

        await handleStatusPage(7, makeClient());

        expect(db.destroyed).toEqual([1]);
    });

    test('losing access removes the subscription', async () => {
        const error = new Error('Missing Access');
        error.code = 50001;
        discord.channelError = error;

        await handleStatusPage(7, makeClient());

        expect(db.destroyed).toEqual([1]);
    });

    test('any other Discord error leaves the subscription alone', async () => {
        // Deleting a customer's subscription because of an unrecognised error would be
        // unrecoverable — they would have to set it up again.
        const error = new Error('Internal Server Error');
        error.code = 50035;
        discord.channelError = error;

        await expect(handleStatusPage(7, makeClient())).resolves.toBeUndefined();
        expect(db.destroyed).toEqual([]);
    });

    test('a channel the bot may not post in does not fail the status page', async () => {
        // 50013 is one guild revoking "Send Messages". Letting it out of the handler advanced
        // the page's BACKOFF, so after four cycles the page was paused and every other guild
        // watching it was told the status page was unreachable. It was not.
        const error = new Error('Missing Permissions');
        error.code = 50013;
        discord.channelError = error;

        await expect(handleStatusPage(7, makeClient())).resolves.toBeUndefined();
        expect(db.destroyed).toEqual([]);
    });

    test('one broken channel does not cost the others their update', async () => {
        db.statuspage.Subscriptions.push({
            ...db.statuspage.Subscriptions[0], id: 2, channelId: 'chan-2',
        });

        const error = new Error('Missing Permissions');
        error.code = 50013;
        discord.channelError = error;
        discord.failChannels = new Set(['chan-1']);

        await handleStatusPage(7, makeClient());

        expect(discord.sentTo).toEqual(['chan-2']);
    });
});
