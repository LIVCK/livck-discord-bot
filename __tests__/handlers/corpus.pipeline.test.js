/**
 * The corpus through the DECISIONS, not just the rendering.
 *
 * `corpus.golden.test.js` records what each payload looks like once rendered. This records
 * what the bot DOES with it: what it posts, what it edits, what it deliberately leaves alone,
 * and which rows it writes. Those are separate failure modes — a message can be rendered
 * perfectly and still be sent when nothing changed, which is how a bot burns its Discord
 * budget, or not sent when something did, which is how a customer misses an outage.
 *
 * Three cycles per payload, because the interesting behaviour only exists across cycles:
 *
 *   1. nothing tracked yet  → post
 *   2. identical payload    → say nothing at all
 *   3. a service goes down  → edit, exactly once, and only the affected subscription's message
 *
 * Discord is recorded rather than called; everything above it is the real code path.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { jest } from '@jest/globals';

const CORPUS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/corpus');
const files = fs.readdirSync(CORPUS).filter((f) => f.endsWith('.json') && f.startsWith('cloud-')).sort();

/** What the provider hands back this cycle. */
const provider = { snapshot: null };

jest.unstable_mockModule('../../providers/index.js', () => ({
    fetchSnapshot: async () => provider.snapshot,
    fetchClosedAlert: async () => null,
    resolveSource: async () => 'CLOUD',
    clearSnapshotCache: () => {},
    NotLivckError: class NotLivckError extends Error {},
    default: {},
}));

const db = { messages: [], destroyed: [] };
let nextRowId = 1;

jest.unstable_mockModule('../../models/index.js', () => ({
    default: {
        Statuspage: { findOne: async () => db.statuspage },
        Subscription: { destroy: async ({ where }) => { db.destroyed.push(where.id); } },
        CustomLink: { findAll: async () => [] },
        RoleMention: { findAll: async () => [] },
        Message: {
            findOne: async ({ where }) => db.messages.find((m) =>
                m.subscriptionId === where.subscriptionId && m.category === where.category
                && (where.serviceId === undefined || m.serviceId === where.serviceId)) ?? null,
            findAll: async ({ where }) => db.messages.filter((m) =>
                m.subscriptionId === where.subscriptionId && m.category === where.category),
            update: async (values, { where }) => {
                const row = db.messages.find((m) => m.id === where.id);
                if (row) { Object.assign(row, values); row.updatedAt = new Date(); }
                return [row ? 1 : 0];
            },
            create: async (row) => {
                const record = {
                    id: nextRowId += 1,
                    ...row,
                    // NOW, like a real row.
                    //
                    // A fixed date here made the whole file depend on the wall clock: the
                    // status message carries `heartbeat: true`, so once the stamp was older
                    // than STATUS_REFRESH_MINUTES the second cycle refreshed instead of
                    // staying silent, and every assertion about "unchanged costs nothing"
                    // failed. It passed for the first fifteen minutes after it was written
                    // and would have failed in CI from then on, at no particular time.
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    update: async function (fields) { Object.assign(this, fields); this.updatedAt = new Date(); },
                    destroy: async function () { db.messages = db.messages.filter((m) => m !== this); },
                };
                db.messages.push(record);
                return record;
            },
        },
    },
}));

const { handleStatusPage } = await import('../../handlers/handleStatuspage.js');
const { toSnapshot } = await import('../../providers/cloud.js');
const { clearSnapshotCache } = await import('../../providers/index.js');

const PAGE = { url: 'https://corpus.example', name: 'corpus' };

const discord = { log: [] };

const client = {
    channels: {
        fetch: async (id) => ({
            id,
            send: async () => { discord.log.push({ channel: id, action: 'send' }); return { id: `msg-${discord.log.length}` }; },
            messages: {
                edit: async () => { discord.log.push({ channel: id, action: 'edit' }); return {}; },
                delete: async () => {},
            },
        }),
    },
};

const subscription = (id, layout, locale) => ({
    id, channelId: `chan-${id}`, layout, locale,
    apiToken: null, eventTypes: { STATUS: true, NEWS: false },
    createdAt: new Date('2020-01-01'),
});

/** One service somewhere in the tree goes down. */
const breakOneService = (payload) => {
    const clone = JSON.parse(JSON.stringify(payload));
    const walk = (nodes) => {
        for (const node of nodes ?? []) {
            if (!node.is_group && node.status === 'operational') { node.status = 'major_outage'; return true; }
            if (node.is_group && walk(node.children)) { node.status = 'major_outage'; return true; }
        }
        return false;
    };
    return walk(clone.components) ? clone : null;
};

describe.each(files)('%s', (file) => {
    const payload = JSON.parse(fs.readFileSync(path.join(CORPUS, file), 'utf8'));

    beforeEach(() => {
        db.messages = [];
        db.destroyed = [];
        nextRowId = 1;
        discord.log = [];
        clearSnapshotCache();

        db.statuspage = {
            id: 1, url: PAGE.url, name: PAGE.name, kind: 'CLOUD', externalId: 'x',
            save: async () => {},
            Subscriptions: [
                subscription(1, 'DETAILED', 'de'),
                subscription(2, 'COMPACT', 'en'),
            ],
        };
    });

    test('is posted once, then never again while it is unchanged', async () => {
        provider.snapshot = toSnapshot(payload, PAGE);

        await handleStatusPage(1, client);
        const afterFirst = [...discord.log];

        clearSnapshotCache();
        await handleStatusPage(1, client);

        expect(afterFirst.every((entry) => entry.action === 'send')).toBe(true);
        expect(afterFirst).toHaveLength(db.statuspage.Subscriptions.length);
        // The second cycle is the one that matters: an unchanged page must cost nothing.
        expect(discord.log).toHaveLength(afterFirst.length);
    });

    test('writes exactly one tracked row per subscription, with a hash', async () => {
        provider.snapshot = toSnapshot(payload, PAGE);
        await handleStatusPage(1, client);

        const rows = db.messages.filter((m) => m.category === 'STATUS');
        expect(rows).toHaveLength(db.statuspage.Subscriptions.length);
        for (const row of rows) expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
        expect(new Set(rows.map((r) => r.subscriptionId)).size).toBe(rows.length);
    });

    test('edits once, and only once, when a service goes down', async () => {
        const broken = breakOneService(payload);
        if (!broken) return; // a payload with nothing to break, e.g. the empty page

        provider.snapshot = toSnapshot(payload, PAGE);
        await handleStatusPage(1, client);
        discord.log = [];

        clearSnapshotCache();
        provider.snapshot = toSnapshot(broken, PAGE);
        await handleStatusPage(1, client);

        expect(discord.log.map((e) => e.action)).toEqual(
            db.statuspage.Subscriptions.map(() => 'edit')
        );

        // And settles again immediately.
        discord.log = [];
        clearSnapshotCache();
        await handleStatusPage(1, client);
        expect(discord.log).toHaveLength(0);
    });

    test('the decisions across three cycles, written down', async () => {
        const broken = breakOneService(payload);

        provider.snapshot = toSnapshot(payload, PAGE);
        await handleStatusPage(1, client);
        const cycle1 = discord.log.map((e) => e.action);

        discord.log = [];
        clearSnapshotCache();
        await handleStatusPage(1, client);
        const cycle2 = discord.log.map((e) => e.action);

        discord.log = [];
        clearSnapshotCache();
        provider.snapshot = toSnapshot(broken ?? payload, PAGE);
        await handleStatusPage(1, client);
        const cycle3 = discord.log.map((e) => e.action);

        expect({ cycle1, cycle2, cycle3, rows: db.messages.length }).toMatchSnapshot();
    });
});
