/**
 * Behaviour of the alerts handler.
 *
 * The rules that matter here are about restraint: only ping a role once, never re-post an
 * alert that has not changed, never backfill a channel with history it did not subscribe to,
 * and thread updates under their parent without fetching the parent first.
 */

import { jest } from '@jest/globals';

const api = { responses: {}, calls: [] };

jest.unstable_mockModule('../../api/livck.js', () => ({
    default: class MockLIVCK {
        constructor(baseUrl, version, token, locale) {
            this.baseURL = baseUrl;
            this.token = token;
            this.locale = locale;
        }

        async get(path) {
            api.calls.push({ path, locale: this.locale });
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
        RoleMention: { findAll: async () => db.roleMentions },
        Message: {
            // Used by the close-out reconciliation; without it that path throws into its own
            // catch and the tests would pass while the feature silently did nothing.
            findAll: async ({ where }) => db.messages.filter(
                (m) => m.subscriptionId === where.subscriptionId && m.category === where.category
            ),
            findOne: async ({ where }) => db.messages.find(
                (m) => m.subscriptionId === where.subscriptionId
                    && m.category === where.category
                    && m.serviceId === where.serviceId
            ) ?? null,
            create: async (row) => {
                const record = {
                    ...row,
                    updatedAt: new Date(),
                    update: async (fields) => { Object.assign(record, fields); },
                    destroy: async () => { db.messages = db.messages.filter((m) => m !== record); },
                };
                db.messages.push(record);
                return record;
            },
        },
    },
}));

const { handleAlerts } = await import('../../handlers/handleAlerts.js');
const { HttpError } = await import('../../util/errors.js');
const { clearSnapshotCache } = await import('../../providers/index.js');

/** Simulate the gap between two update cycles — see handleStatuspage.test.js. */
const nextCycle = () => clearSnapshotCache();

const discord = { sent: [], edits: 0, fetches: 0 };

const makeClient = () => ({
    channels: {
        fetch: async (id) => ({
            id,
            send: async (payload) => {
                discord.sent.push(payload);
                return { id: `msg-${discord.sent.length}` };
            },
            messages: {
                edit: async () => { discord.edits += 1; return {}; },
                fetch: async () => { discord.fetches += 1; return {}; },
            },
        }),
    },
});

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

const alert = (overrides = {}) => ({
    id: 'alert-1',
    title: 'Datenbank gestört',
    message: '<p>Wir untersuchen das Problem.</p>',
    type: 'INCIDENT',
    link: 'https://status.example.com/alert/db',
    created_at: hoursAgo(2),
    alerts: [],
    ...overrides,
});

const subscription = (overrides = {}) => ({
    id: 1,
    channelId: 'chan-1',
    locale: 'de',
    apiToken: null,
    eventTypes: { STATUS: false, NEWS: true },
    createdAt: new Date('2020-01-01'),
    ...overrides,
});

beforeEach(() => {
    api.responses = { alerts: { data: [alert()] } };
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
    db.destroyed = [];
    db.roleMentions = [];

    clearSnapshotCache();

    discord.sent = [];
    discord.edits = 0;
    discord.fetches = 0;
});

describe('posting alerts', () => {
    test('posts a new alert once', async () => {
        await handleAlerts(7, makeClient());

        expect(discord.sent).toHaveLength(1);
        expect(discord.sent[0].embeds[0].toJSON().title).toBe('Datenbank gestört');
    });

    test('does not repost an unchanged alert on the next cycle', async () => {
        const client = makeClient();
        await handleAlerts(7, client);
        nextCycle();
        await handleAlerts(7, client);

        expect(discord.sent).toHaveLength(1);
        expect(discord.edits).toBe(0);
    });

    test('edits when the alert text changed', async () => {
        const client = makeClient();
        await handleAlerts(7, client);

        api.responses.alerts = { data: [alert({ message: '<p>Behoben.</p>' })] };
        nextCycle();
        await handleAlerts(7, client);

        expect(discord.edits).toBe(1);
    });

    test('ignores a subscription that opted out of NEWS', async () => {
        db.statuspage.Subscriptions = [subscription({ eventTypes: { STATUS: true, NEWS: false } })];

        await handleAlerts(7, makeClient());

        expect(discord.sent).toHaveLength(0);
    });
});

describe('the three day window', () => {
    test('an alert older than three days is not tracked', async () => {
        api.responses.alerts = { data: [alert({ created_at: hoursAgo(24 * 4) })] };

        await handleAlerts(7, makeClient());

        expect(discord.sent).toHaveLength(0);
    });

    test('an alert just inside the window is', async () => {
        api.responses.alerts = { data: [alert({ created_at: hoursAgo(24 * 2) })] };

        await handleAlerts(7, makeClient());

        expect(discord.sent).toHaveLength(1);
    });
});

describe('subscription age', () => {
    test('a channel is not backfilled with alerts that predate its subscription', async () => {
        db.statuspage.Subscriptions = [subscription({ createdAt: new Date() })];
        api.responses.alerts = { data: [alert({ created_at: hoursAgo(5) })] };

        await handleAlerts(7, makeClient());

        expect(discord.sent).toHaveLength(0);
    });
});

describe('updates thread under their parent', () => {
    const withUpdate = () => alert({
        alerts: [{
            id: 'update-1',
            title: 'Ursache gefunden',
            message: '<p>Ein Node war überlastet.</p>',
            created_at: hoursAgo(1),
        }],
    });

    test('the parent and its update are both posted', async () => {
        api.responses.alerts = { data: [withUpdate()] };

        await handleAlerts(7, makeClient());

        expect(discord.sent).toHaveLength(2);
        expect(discord.sent[1].embeds[0].toJSON().title).toBe('Ursache gefunden');
    });

    test('the update replies to the parent by id, without fetching it', async () => {
        api.responses.alerts = { data: [withUpdate()] };

        await handleAlerts(7, makeClient());

        expect(discord.sent[1].reply).toEqual({ messageReference: 'msg-1', failIfNotExists: false });
        expect(discord.fetches).toBe(0);
    });

    test('an existing parent is reused for later updates', async () => {
        const client = makeClient();
        await handleAlerts(7, client);           // parent only
        api.responses.alerts = { data: [withUpdate()] };
        nextCycle();
        await handleAlerts(7, client);           // update arrives

        const reply = discord.sent.at(-1).reply;
        expect(reply.messageReference).toBe('msg-1');
    });
});

describe('role mentions', () => {
    beforeEach(() => {
        db.roleMentions = [{ roleId: '999', eventType: 'NEWS' }];
    });

    test('a new alert pings the configured roles', async () => {
        await handleAlerts(7, makeClient());

        expect(discord.sent[0].content).toBe('<@&999>');
        expect(discord.sent[0].allowedMentions).toEqual({ roles: ['999'] });
    });

    test('an edit does not ping again', async () => {
        // Discord does not re-notify on edit, so a ping attached to an update would be
        // silent noise in the message body.
        const client = makeClient();
        await handleAlerts(7, client);

        api.responses.alerts = { data: [alert({ message: '<p>Behoben.</p>' })] };
        nextCycle();
        await handleAlerts(7, client);

        expect(discord.edits).toBe(1);
        expect(discord.sent).toHaveLength(1);
    });
});

describe('alert kinds', () => {
    const colorOf = () => discord.sent[0].embeds[0].toJSON().color;

    test('an incident is red', async () => {
        api.responses.alerts = { data: [alert({ type: 'INCIDENT' })] };
        await handleAlerts(7, makeClient());
        expect(colorOf()).toBe(0xED4245);
    });

    test('a scheduled item is amber, not red', async () => {
        api.responses.alerts = { data: [alert({ type: 'MAINTENANCE', scheduled_for: hoursAgo(-24) })] };
        await handleAlerts(7, makeClient());
        expect(colorOf()).toBe(0xFEE75C);
    });

    test('anything else is informational', async () => {
        api.responses.alerts = { data: [alert({ type: 'INFORMATION' })] };
        await handleAlerts(7, makeClient());
        expect(colorOf()).toBe(0x5865F2);
    });
});

describe('channel problems', () => {
    const channelError = (code) => {
        const error = new Error(`code ${code}`);
        error.code = code;
        return error;
    };

    const clientThatFails = (error) => ({
        channels: { fetch: async () => { throw error; } },
    });

    test('a deleted channel removes the subscription', async () => {
        await handleAlerts(7, clientThatFails(channelError(10003)));
        expect(db.destroyed).toEqual([1]);
    });

    test('losing access removes the subscription', async () => {
        await handleAlerts(7, clientThatFails(channelError(50001)));
        expect(db.destroyed).toEqual([1]);
    });

    test('an unrecognised Discord error leaves the subscription alone', async () => {
        await expect(handleAlerts(7, clientThatFails(channelError(50035)))).resolves.toBeUndefined();
        expect(db.destroyed).toEqual([]);
    });

    test('a channel the bot may not post in does not fail the status page', async () => {
        // 50013: one guild revoked "Send Messages". It used to escape the handler and advance
        // the page's backoff, which paused the page — and announced it — for every other guild.
        await expect(handleAlerts(7, clientThatFails(channelError(50013)))).resolves.toBeUndefined();
        expect(db.destroyed).toEqual([]);
    });
});

describe('fetch failures', () => {
    test('throws when every group failed', async () => {
        api.responses.alerts = new HttpError(503, 'Service Unavailable');

        await expect(handleAlerts(7, makeClient())).rejects.toMatchObject({ status: 503 });
    });

    test('posts nothing when the fetch failed', async () => {
        api.responses.alerts = new HttpError(500, 'Server Error');

        await handleAlerts(7, makeClient()).catch(() => {});

        expect(discord.sent).toHaveLength(0);
    });

    test('an unknown statuspage id is a no-op', async () => {
        db.statuspage = null;
        await expect(handleAlerts(999, makeClient())).resolves.toBeUndefined();
    });
});
