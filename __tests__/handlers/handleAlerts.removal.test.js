/**
 * Removing the thread of an alert that is no longer on the status page.
 *
 * A Discord channel is a just-in-time feed; the status page is the record. When an operator
 * takes an alert off the page nobody watching the page is told, because the usual reason is
 * that it should not have been published — so the bot says nothing either and removes what it
 * posted. Deleting a message notifies no one, which is the whole point.
 *
 * The verdict that gets it here is tested in providers/closedAlertVerdict.test.js. What is
 * tested HERE is the irreversible half: that the right messages go, in the right order, and
 * that everything the bot is not sure about survives.
 */

import { jest } from '@jest/globals';

const provider = { snapshot: null, closed: {}, lastOptions: undefined };

jest.unstable_mockModule('../../providers/index.js', () => ({
    fetchSnapshot: async () => provider.snapshot,
    fetchClosedAlert: async (_page, alertId, _kind, options) => {
        provider.lastOptions = options;
        const value = provider.closed[alertId];
        if (value instanceof Error) throw value;
        if (value && typeof value === 'object' && 'removed' in value) return value;
        return { alert: value ?? null, removed: false };
    },
    resolveSource: async () => 'CLOUD',
    clearSnapshotCache: () => {},
    NotLivckError: class NotLivckError extends Error {},
    default: {},
}));

const db = {};

/** The `where` clauses this handler actually issues, no more. */
const matches = (row, where) => Object.entries(where).every(([key, want]) => {
    if (key === 'createdAt') return new Date(row.createdAt).getTime() >= want[Object.getOwnPropertySymbols(want)[0]].getTime();
    if (want && typeof want === 'object' && !(want instanceof Date)) {
        const values = Object.values(want)[0] ?? want[Object.getOwnPropertySymbols(want)[0]];
        return Array.isArray(values) ? values.includes(row[key]) : row[key] === values;
    }
    return row[key] === want;
});

jest.unstable_mockModule('../../models/index.js', () => ({
    default: {
        Statuspage: { findOne: async () => db.statuspage },
        Subscription: { destroy: async ({ where }) => { db.destroyedSubs.push(where.id); } },
        RoleMention: { findAll: async () => [] },
        Message: {
            findAll: async ({ where }) => db.messages.filter((row) => matches(row, where)),
            findOne: async ({ where }) => db.messages.find((row) => matches(row, where)) ?? null,
            update: async () => [0],
            create: async (row) => { db.messages.push(row); return row; },
            destroy: async ({ where }) => {
                const before = db.messages.length;
                db.messages = db.messages.filter((row) => row.id !== where.id);
                return before - db.messages.length;
            },
        },
    },
}));

const { handleAlerts, clearCloseoutCooldowns } = await import('../../handlers/handleAlerts.js');
const { SOURCE, STATUS, makeSnapshot } = await import('../../dto/statuspage.js');

const discord = { deleted: [], sent: [], edits: 0, failDelete: null };

const makeClient = () => ({
    channels: {
        fetch: async (id) => ({
            id,
            send: async (payload) => { discord.sent.push(payload); return { id: 'new-msg' }; },
            messages: {
                edit: async () => { discord.edits += 1; return {}; },
                delete: async (messageId) => {
                    if (discord.failDelete) {
                        const error = new Error(discord.failDelete.message);
                        error.code = discord.failDelete.code;
                        throw error;
                    }
                    discord.deleted.push(messageId);
                },
            },
        }),
    },
});

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000);

/** A parent and two replies, exactly as deliverAlert writes them. */
const thread = (alertId = 'inc-1') => [
    { id: 1, subscriptionId: 1, category: 'NEWS', serviceId: alertId, alertId, messageId: 'parent', kind: 'incident', createdAt: hoursAgo(5) },
    { id: 2, subscriptionId: 1, category: 'ALERT', serviceId: 'upd-1', alertId, messageId: 'reply-1', kind: 'incident', createdAt: hoursAgo(4) },
    { id: 3, subscriptionId: 1, category: 'ALERT', serviceId: 'upd-2', alertId, messageId: 'reply-2', kind: 'incident', createdAt: hoursAgo(3) },
];

const snapshot = (showIncidentHistory = true) => makeSnapshot({
    source: SOURCE.CLOUD,
    url: 'https://status.example.com',
    name: { de: 'Example' },
    overall: STATUS.OPERATIONAL,
    defaultLocale: 'de',
    locales: ['de'],
    groups: [],
    alerts: [],
    showIncidentHistory,
});

beforeEach(() => {
    clearCloseoutCooldowns();

    provider.snapshot = snapshot();
    provider.closed = {};
    provider.lastOptions = undefined;

    db.statuspage = {
        id: 7,
        url: 'https://status.example.com',
        name: 'Example',
        kind: 'CLOUD',
        externalId: 'page-id',
        save: async () => {},
        Subscriptions: [{
            id: 1,
            channelId: 'chan-1',
            locale: 'de',
            apiToken: null,
            eventTypes: { STATUS: false, NEWS: true },
            createdAt: new Date('2020-01-01'),
        }],
    };
    db.messages = thread();
    db.destroyedSubs = [];

    discord.deleted = [];
    discord.sent = [];
    discord.edits = 0;
    discord.failDelete = null;
});

describe('an alert the operator took off the page', () => {
    test('takes its whole thread with it', async () => {
        provider.closed['inc-1'] = { alert: null, removed: true };

        await handleAlerts(7, makeClient());

        expect(discord.deleted).toHaveLength(3);
        expect(db.messages).toHaveLength(0);
    });

    test('loses its replies before its parent', async () => {
        // The other order leaves "Original message was deleted" standing under every reply
        // for as long as the deletes take, which is the state this whole path exists to avoid.
        provider.closed['inc-1'] = { alert: null, removed: true };

        await handleAlerts(7, makeClient());

        expect(discord.deleted).toEqual(['reply-1', 'reply-2', 'parent']);
    });

    test('goes silently — nothing is posted and nothing is edited', async () => {
        // The page announced no retraction. Neither does the bot.
        provider.closed['inc-1'] = { alert: null, removed: true };

        await handleAlerts(7, makeClient());

        expect(discord.sent).toEqual([]);
        expect(discord.edits).toBe(0);
    });

    test('leaves another subscription\'s thread for that subscription to handle', async () => {
        db.messages.push(
            { id: 4, subscriptionId: 2, category: 'NEWS', serviceId: 'inc-1', alertId: 'inc-1', messageId: 'other-parent', kind: 'incident', createdAt: hoursAgo(5) },
        );
        provider.closed['inc-1'] = { alert: null, removed: true };

        await handleAlerts(7, makeClient());

        // Subscription 2 is not on this status page in this test, so its row must survive:
        // the delete is scoped by subscription, never by alert alone.
        expect(db.messages.map((row) => row.id)).toEqual([4]);
    });
});

describe('what it refuses to delete', () => {
    test('a thread whose parent predates the alertId column', async () => {
        // Its replies cannot be enumerated, so deleting the parent would leave a column of
        // "Original message was deleted" behind. Better a stale thread than a broken one.
        db.messages = db.messages.map((row) => ({ ...row, alertId: row.category === 'NEWS' ? null : row.alertId }));
        provider.closed['inc-1'] = { alert: null, removed: true };

        await handleAlerts(7, makeClient());

        expect(discord.deleted).toEqual([]);
        expect(db.messages).toHaveLength(3);
    });

    test('anything the provider is not sure about', async () => {
        // The verdict is false for a 404 that could mean "history hidden", and for every
        // error. None of them may reach the delete.
        provider.closed['inc-1'] = { alert: null, removed: false };

        await handleAlerts(7, makeClient());

        expect(discord.deleted).toEqual([]);
        expect(db.messages).toHaveLength(3);
    });

    test('an alert that is merely outside the reporting window', async () => {
        db.messages = thread().map((row) => ({ ...row, createdAt: hoursAgo(24 * 4) }));
        provider.closed['inc-1'] = { alert: null, removed: true };

        await handleAlerts(7, makeClient());

        expect(discord.deleted).toEqual([]);
        expect(db.messages).toHaveLength(3);
    });
});

describe('when Discord does not cooperate', () => {
    test('a message it no longer has still drops its row', async () => {
        // 10008 is the message already being gone, which is the outcome this wanted anyway.
        discord.failDelete = { code: 10008, message: 'Unknown Message' };
        provider.closed['inc-1'] = { alert: null, removed: true };

        await handleAlerts(7, makeClient());

        expect(db.messages).toHaveLength(0);
    });

    test('a refused delete keeps the thread instead of losing track of it', async () => {
        // "Manage Messages" is not one of the four permissions the bot asks for. A server that
        // denies the delete must end up with an intact thread, not half a thread and no rows.
        discord.failDelete = { code: 50013, message: 'Missing Permissions' };
        provider.closed['inc-1'] = { alert: null, removed: true };

        await handleAlerts(7, makeClient());

        expect(db.messages).toHaveLength(3);
    });
});

describe('the flag the verdict depends on', () => {
    test('reaches the provider from the snapshot', async () => {
        provider.snapshot = snapshot(false);
        provider.closed['inc-1'] = { alert: null, removed: false };

        await handleAlerts(7, makeClient());

        expect(provider.lastOptions).toEqual({ historyVisible: false });
    });

    test('is passed as null when the payload did not carry it', async () => {
        provider.snapshot = snapshot(null);
        provider.closed['inc-1'] = { alert: null, removed: false };

        await handleAlerts(7, makeClient());

        expect(provider.lastOptions).toEqual({ historyVisible: null });
    });
});
