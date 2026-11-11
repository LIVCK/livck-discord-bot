/**
 * The irreversible delete, wired end to end.
 *
 * handleAlerts.removal.test.js and handleAlerts.closeout.test.js mock the provider, and
 * closedAlertVerdict.test.js tests the provider alone. Each side was right and the JOIN was
 * untested: the handler could pass the wrong kind into the verdict — or none — and every suite
 * stayed green while a page that merely hides its resolved incidents had its threads deleted.
 *
 * Here only the network is fake. The handler, providers/index.js and providers/cloud.js are the
 * real ones, and the status page answers 404 on both detail endpoints, which is what a page
 * with `show_incident_history` off does for an incident that simply resolved.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { jest } from '@jest/globals';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const basePayload = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'corpus/cloud-01-all-green.json'), 'utf8'));

const db = {};

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
        Subscription: { destroy: async () => 0 },
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
const { resetDelivery } = await import('../../util/delivery.js');
const { clearSnapshotCache } = await import('../../providers/index.js');

const PAGE_ID = 'verdictPage';
const page = { historyShown: false, requests: [], incidents: [] };

const json = (status, body) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
});

const realFetch = global.fetch;
beforeAll(() => {
    global.fetch = async (url) => {
        const { pathname } = new URL(url);
        page.requests.push(pathname);
        if (pathname === `/api/statuspage/${PAGE_ID}/full`) {
            return json(200, {
                ...basePayload,
                meta: { ...basePayload.meta, id: PAGE_ID, show_incident_history: page.historyShown },
                active_incidents: page.incidents, notices: [], maintenances: [],
            });
        }
        // Both detail endpoints: nothing here, whatever was asked for.
        return json(404, { message: 'Not found' });
    };
});
afterAll(() => { global.fetch = realFetch; });

const discord = { deleted: [] };
const client = {
    channels: {
        fetch: async (id) => ({
            id,
            send: async () => ({ id: 'new' }),
            messages: {
                edit: async () => ({}),
                delete: async (messageId) => { discord.deleted.push(messageId); },
            },
        }),
    },
};

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000);
const threadOf = (kind) => [
    { id: 1, subscriptionId: 1, category: 'NEWS', serviceId: 'a-1', alertId: 'a-1', messageId: 'parent', kind, createdAt: hoursAgo(5) },
    { id: 2, subscriptionId: 1, category: 'ALERT', serviceId: 'u-1', alertId: 'a-1', messageId: 'reply', kind, createdAt: hoursAgo(4) },
];

beforeEach(() => {
    resetDelivery();
    clearCloseoutCooldowns();
    clearSnapshotCache();
    page.requests = [];
    page.incidents = [];
    discord.deleted = [];
    db.statuspage = {
        id: 7, url: 'https://status.example.com', name: 'Example', kind: 'CLOUD', externalId: PAGE_ID,
        save: async () => {},
        Subscriptions: [{
            id: 1, channelId: 'chan-1', locale: 'de', apiToken: null,
            eventTypes: { STATUS: false, NEWS: true }, createdAt: new Date('2020-01-01'),
        }],
    };
});

describe('a page that hides its resolved incidents', () => {
    test('keeps the thread of an incident that only resolved', async () => {
        page.historyShown = false;
        db.messages = threadOf('incident');

        await handleAlerts(7, client);

        // It was asked — so this is not passing for want of a lookup — and nothing went.
        expect(page.requests).toContain(`/api/statuspage/${PAGE_ID}/incidents/a-1`);
        expect(discord.deleted).toEqual([]);
        expect(db.messages).toHaveLength(2);
    });

    test('keeps the thread of a notice too', async () => {
        page.historyShown = false;
        db.messages = threadOf('notice');

        await handleAlerts(7, client);

        expect(discord.deleted).toEqual([]);
    });

    test('still removes a maintenance window that is gone: that 404 is definitive', async () => {
        page.historyShown = false;
        db.messages = threadOf('maintenance');

        await handleAlerts(7, client);

        expect(discord.deleted).toEqual(['reply', 'parent']);
    });
});

describe('a page that shows its history', () => {
    test('removes an incident that is gone from both endpoints', async () => {
        page.historyShown = true;
        db.messages = threadOf('incident');

        await handleAlerts(7, client);

        expect(discord.deleted).toEqual(['reply', 'parent']);
    });
});

describe('a row from before the kind was recorded', () => {
    test('is never deleted on a page that hides its history', async () => {
        page.historyShown = false;
        db.messages = threadOf(null);

        await handleAlerts(7, client);

        expect(discord.deleted).toEqual([]);
    });
});

describe('what the verdict reads later', () => {
    test('every row of a delivered thread records what kind of alert it was', async () => {
        // Written once, read days later when the alert has left the payload: without it the
        // row above counts as "kind unknown" and the verdict cannot be made safely.
        const now = Date.now();
        page.incidents = [{
            id: 'live-1', title: { de: 'Störung', en: 'Outage' }, severity: 'major', status: 'identified',
            started_at: new Date(now - 60_000).toISOString(), resolved_at: null,
            updates: [
                { id: 'lu-2', status: 'identified', message: { de: 'Gefunden', en: 'Found' }, created_at: new Date(now - 30_000).toISOString() },
                { id: 'lu-1', status: 'investigating', message: { de: 'Wir schauen', en: 'Looking' }, created_at: new Date(now - 60_000).toISOString() },
            ],
            affected_components: [], affected_services: [], attachments: [], postmortem: null,
        }];
        db.messages = [];

        await handleAlerts(7, client);

        expect(db.messages.map((row) => [row.category, row.serviceId, row.kind])).toEqual([
            ['NEWS', 'live-1', 'incident'],
            ['ALERT', 'lu-2', 'incident'],
        ]);
    });
});
