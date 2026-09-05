/**
 * Closing out a thread whose alert has left the live payload.
 *
 * The Cloud drops an incident from `active_incidents` the moment it resolves. Without this the
 * last thing a Discord thread ever shows is "we are monitoring", which reads as an ongoing
 * outage long after everything is fine.
 *
 * What matters here is restraint as much as completeness: the bot must close a thread when it
 * can confirm the ending, and must say nothing at all when it cannot.
 */

import { jest } from '@jest/globals';

const provider = { snapshot: null, closed: {}, closedCalls: [] };

jest.unstable_mockModule('../../providers/index.js', () => ({
    fetchSnapshot: async () => provider.snapshot,
    fetchClosedAlert: async (_statuspage, alertId) => {
        provider.closedCalls.push(alertId);
        const value = provider.closed[alertId];
        if (value instanceof Error) throw value;
        return value ?? null;
    },
    resolveSource: async () => 'CLOUD',
    clearSnapshotCache: () => {},
    NotLivckError: class NotLivckError extends Error {},
    default: {},
}));

const db = {};

jest.unstable_mockModule('../../models/index.js', () => ({
    default: {
        Statuspage: { findOne: async () => db.statuspage },
        Subscription: { destroy: async ({ where }) => { db.destroyed.push(where.id); } },
        RoleMention: { findAll: async () => [] },
        Message: {
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
                    createdAt: new Date(),
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
const { ALERT_KIND, BODY_FORMAT, SOURCE, STATUS, makeAlert, makeSnapshot, makeUpdate } =
    await import('../../dto/statuspage.js');

const discord = { sent: [], edits: 0 };

const makeClient = () => ({
    channels: {
        fetch: async (id) => ({
            id,
            send: async (payload) => { discord.sent.push(payload); return { id: `msg-${discord.sent.length}` }; },
            messages: { edit: async () => { discord.edits += 1; return {}; } },
        }),
    },
});

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

const incident = (overrides = {}) => makeAlert({
    id: 'inc-1',
    kind: ALERT_KIND.INCIDENT,
    url: 'https://status.example.com/incidents/inc-1',
    title: { de: 'Störung' },
    body: { de: 'Wir untersuchen das.' },
    format: BODY_FORMAT.MARKDOWN,
    severity: 'major',
    state: 'monitoring',
    startedAt: hoursAgo(5),
    updates: [],
    ...overrides,
});

const snapshotWith = (alerts) => makeSnapshot({
    source: SOURCE.CLOUD,
    url: 'https://status.example.com',
    name: { de: 'Example' },
    overall: STATUS.OPERATIONAL,
    defaultLocale: 'de',
    locales: ['de'],
    groups: [],
    alerts,
});

const trackedMessage = (serviceId, ageHours = 2) => ({
    subscriptionId: 1,
    category: 'NEWS',
    serviceId,
    messageId: 'msg-1',
    contentHash: 'whatever',
    createdAt: new Date(Date.now() - ageHours * 3600 * 1000),
    updatedAt: new Date(Date.now() - ageHours * 3600 * 1000),
    update: async function (f) { Object.assign(this, f); },
    destroy: async () => {},
});

beforeEach(() => {
    provider.snapshot = snapshotWith([]);
    provider.closed = {};
    provider.closedCalls = [];

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
    db.messages = [];
    db.destroyed = [];

    discord.sent = [];
    discord.edits = 0;
});

describe('an alert that vanished from the live payload', () => {
    test('is looked up so the thread can be finished', async () => {
        db.messages.push(trackedMessage('inc-1'));

        provider.closed['inc-1'] = incident({
            state: 'resolved',
            endedAt: hoursAgo(1),
            updates: [makeUpdate({ id: 'u-final', state: 'resolved', body: { de: 'Behoben.' }, createdAt: hoursAgo(1) })],
        });

        await handleAlerts(7, makeClient());

        expect(provider.closedCalls).toEqual(['inc-1']);
        // The closing update lands as one more reply in the same thread.
        expect(discord.sent.some((p) => p.embeds[0].toJSON().description.includes('Behoben'))).toBe(true);
    });

    test('is not looked up while it is still live', async () => {
        // The ordinary case: nothing disappeared, so nothing is asked for. This is what keeps
        // the close-out free in steady state.
        provider.snapshot = snapshotWith([incident()]);
        db.messages.push(trackedMessage('inc-1'));

        await handleAlerts(7, makeClient());

        expect(provider.closedCalls).toEqual([]);
    });

    test('is left completely alone when the page will not confirm it', async () => {
        // `show_incident_history` off → the detail endpoint 404s → fetchClosedAlert returns
        // null. Claiming a resolution the bot cannot see would be worse than saying nothing.
        db.messages.push(trackedMessage('inc-1'));
        provider.closed['inc-1'] = null;

        await handleAlerts(7, makeClient());

        expect(provider.closedCalls).toEqual(['inc-1']);
        expect(discord.sent).toHaveLength(0);
        expect(discord.edits).toBe(0);
    });

    test('is never touched again once it is out of the reporting window', async () => {
        // Without this bound an unconfirmable thread would be re-queried every 15 seconds,
        // for ever.
        db.messages.push(trackedMessage('inc-old', 24 * 5));

        await handleAlerts(7, makeClient());

        expect(provider.closedCalls).toEqual([]);
    });

    test('a maintenance window is closed out the same way', async () => {
        db.messages.push(trackedMessage('maint-1'));

        provider.closed['maint-1'] = makeAlert({
            id: 'maint-1',
            kind: ALERT_KIND.MAINTENANCE,
            url: 'https://status.example.com/maintenances/maint-1',
            title: { de: 'Datenbank-Upgrade' },
            body: { de: 'Wartung startet.' },
            format: BODY_FORMAT.MARKDOWN,
            state: 'completed',
            startedAt: hoursAgo(6),
            window: { start: hoursAgo(6), end: hoursAgo(1) },
            updates: [makeUpdate({ id: 'mu-final', state: 'completed', body: { de: 'Wartung abgeschlossen.' }, createdAt: hoursAgo(1) })],
        });

        await handleAlerts(7, makeClient());

        expect(discord.sent.some((p) => p.embeds[0].toJSON().description.includes('abgeschlossen'))).toBe(true);
    });

    test('a lookup failure does not fail the cycle', async () => {
        // The live part already succeeded; closing out is best effort.
        db.messages.push(trackedMessage('inc-1'));
        provider.closed['inc-1'] = Object.assign(new Error('upstream down'), { status: 503 });

        await expect(handleAlerts(7, makeClient())).resolves.toBeUndefined();
    });

    test('a subscription that opted out of NEWS is not reconciled', async () => {
        db.statuspage.Subscriptions[0].eventTypes = { STATUS: true, NEWS: false };
        db.messages.push(trackedMessage('inc-1'));

        await handleAlerts(7, makeClient());

        expect(provider.closedCalls).toEqual([]);
    });
});

describe('idempotence', () => {
    test('a second cycle adds nothing', async () => {
        // The closing reply goes through the same syncMessage path as everything else, so its
        // Message row is what stops it being posted twice.
        db.messages.push(trackedMessage('inc-1'));
        provider.closed['inc-1'] = incident({
            state: 'resolved',
            updates: [makeUpdate({ id: 'u-final', state: 'resolved', body: { de: 'Behoben.' }, createdAt: hoursAgo(1) })],
        });

        const client = makeClient();
        await handleAlerts(7, client);
        const afterFirst = discord.sent.length;

        await handleAlerts(7, client);

        expect(discord.sent).toHaveLength(afterFirst);
    });
});
