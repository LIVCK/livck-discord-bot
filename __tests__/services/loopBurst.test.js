/**
 * More to send at once than Discord takes in a second.
 *
 * Discord allows a bot 50 requests per second in total, and discord.js holds back whatever
 * goes over that in its own queue. Usually the bot sends almost nothing, because an unchanged
 * status message is not edited. But some moments ask for everything at once: the first cycle
 * after a restart that outlasted STATUS_REFRESH_MINUTES (every heartbeat is due), a deploy
 * with many new subscriptions, an outage of a page hundreds of channels follow.
 *
 * Every one of those requests is healthy. Waiting in the queue is not a channel failing, and
 * must not be counted as one: a delivery that times out goes into a backoff and is logged as a
 * channel that does not answer.
 *
 * Scaled: 20 requests per second instead of 50, and a 2.5s deadline instead of 10s. Not
 * shorter, because discord.js counts the global limit in a fixed one-second window — a request
 * that finds it used up waits for the next one, which costs a tenth of the deadline in
 * production and would cost all of it at 1s. The burst is three deadlines' worth of queue, in
 * production about 1500 requests at once. The delivery slots (util/delivery.js) are scaled
 * too: 25 in production hold a fraction of a second of requests, 4 do here.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { jest } from '@jest/globals';
import { Client } from 'discord.js';
import { startFakeDiscord } from '../fixtures/fakeDiscord.js';
import { createMemoryModels } from '../fixtures/memoryModels.js';

process.env.DISCORD_DELIVERY_TIMEOUT_MS = '2500';
process.env.DELIVERY_BACKOFF_BASE_MS = '300';
process.env.DISCORD_DELIVERY_SLOTS = '4';
/** Twice the delivery deadline, as in production (20s against 10s). */
process.env.UPDATE_PAGE_DEADLINE_MS = '5000';
// The timeout line is a warning, and the logger shows only errors under test by default.
process.env.LOG_LEVEL = 'warn';

const REQUESTS_PER_SECOND = 20;
const PAGES = 25;
const CHANNELS_PER_PAGE = 3;

const CORPUS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/corpus');
const corpus = (file) => JSON.parse(fs.readFileSync(path.join(CORPUS, file), 'utf8'));

const memory = createMemoryModels();
const snapshots = new Map();

jest.unstable_mockModule('../../models/index.js', () => ({ default: memory.models }));
jest.unstable_mockModule('../../providers/index.js', () => ({
    fetchSnapshot: async (page) => snapshots.get(page.id),
    fetchClosedAlert: async () => ({ alert: null, removed: false }),
    resolveSource: async () => 'CLOUD',
    clearSnapshotCache: () => {},
    NotLivckError: class NotLivckError extends Error {},
    default: {},
}));
jest.unstable_mockModule('../../database/redis.js', () => ({
    default: { set: async () => 'OK', get: async () => null, del: async () => 1, isOpen: false },
}));
jest.unstable_mockModule('../../services/statuspagePauseManager.js', () => ({
    default: { handleSuccess: async () => false, handleFailure: async () => ({ level: 1, marked: false }) },
    NOTIFY_AT_LEVEL: 4,
    BACKOFF_LADDER_MS: [1000],
}));

const { runCycle } = await import('../../services/updateLoop.js');
const { toSnapshot } = await import('../../providers/cloud.js');
const { createRestPolicy } = await import('../../discord/restPolicy.js');
const { resetDelivery, drainDeliveries } = await import('../../util/delivery.js');

const GREEN = toSnapshot(corpus('cloud-01-all-green.json'), { url: 'https://burst.example', name: 'Burst' });

const ONE_DOWN = corpus('cloud-02-single-outage.json');

/** The corpus alert, moved into the present: the bot ignores anything older than three days. */
const withFreshAlert = (payload) => {
    const snapshot = toSnapshot(payload, { url: 'https://burst.example', name: 'Burst' });
    const now = new Date().toISOString();
    return { ...snapshot, alerts: snapshot.alerts.slice(0, 1).map((alert) => ({ ...alert, startedAt: now })) };
};

let base = 7000;

const setup = async () => {
    const said = [];
    jest.spyOn(console, 'warn').mockImplementation((...args) => said.push(args.join(' ')));
    jest.spyOn(console, 'error').mockImplementation((...args) => said.push(args.join(' ')));
    resetDelivery();
    memory.reset();
    snapshots.clear();

    const fake = await startFakeDiscord();
    const policy = createRestPolicy({ log: () => {} });
    const client = new Client({
        intents: [],
        rest: { ...policy.options, api: fake.api, globalRequestsPerSecond: REQUESTS_PER_SECOND },
    });
    policy.attach(client.rest);
    client.rest.setToken('fake-token');
    client.guilds._add({ id: fake.guildId, name: 'Fake Guild', channels: [], roles: [], members: [] });

    const channels = [];
    base += 100;
    for (let p = 0; p < PAGES; p += 1) {
        const pageId = base + p;
        memory.addPage({ id: pageId, url: `https://burst-${pageId}.example`, name: `Burst ${p}` });
        snapshots.set(pageId, GREEN);
        for (let c = 0; c < CHANNELS_PER_PAGE; c += 1) {
            const channelId = String(1600000000000000000n + BigInt(pageId * 10 + c));
            memory.subscribe({ id: pageId * 10 + c, statuspageId: pageId, channelId });
            channels.push(channelId);
        }
    }

    const teardown = async () => {
        fake.release();
        await drainDeliveries();
        policy.stop();
        client.destroy();
        await fake.close();
        jest.restoreAllMocks();
    };

    return { said, fake, client, channels, teardown };
};

/** Cycles keep coming (here: whenever the last one is done), as in production. */
const cycleUntil = async (client, done, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until && !done()) {
        await runCycle(client);
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
};

test('a burst bigger than the global limit is delivered whole, and nobody is blamed for it', async () => {
    const { said, fake, client, channels, teardown } = await setup();

    try {
        await cycleUntil(client, () => channels.every((id) => fake.messagesIn(id).length >= 1), 30_000);
        await drainDeliveries();

        const missing = channels.filter((id) => fake.messagesIn(id).length !== 1);
        expect(missing).toEqual([]);
        expect(fake.invalidRequests()).toEqual([]);
        // Neither the channels nor the pages: a page whose deliveries are waiting their turn
        // is not a page that is stuck.
        expect(said.filter((line) => /has not answered|Could not deliver|still running after/.test(line))).toEqual([]);
    } finally {
        await teardown();
    }
}, 60000);

test('an incident in the middle of it does not wait for the burst', async () => {
    // What the 15-second loop is for. The alert used to queue behind every heartbeat edit.
    const { fake, client, channels, teardown } = await setup();
    const pageId = base + PAGES - 1;
    const alertChannel = String(1600000000000000000n + BigInt(pageId * 10 + 9));
    memory.subscribe({ id: pageId * 10 + 9, statuspageId: pageId, channelId: alertChannel, eventTypes: { STATUS: false, NEWS: true } });
    snapshots.set(pageId, withFreshAlert(ONE_DOWN));

    try {
        const started = Date.now();
        await cycleUntil(client, () => channels.every((id) => fake.messagesIn(id).length >= 1), 30_000);
        await drainDeliveries();

        const firstPost = (channelId) => fake.requests(channelId, { method: 'POST' })[0]?.at;
        const alertAt = firstPost(alertChannel) - started;
        const lastStatusAt = Math.max(...channels.map(firstPost)) - started;

        expect(fake.messagesIn(alertChannel).length).toBeGreaterThanOrEqual(1);
        // Out in the first half of the burst, not at its end. It typically lands in the first
        // tenth; half leaves room for a slow machine and still fails the code this replaced,
        // where the alert came out last.
        expect(alertAt).toBeLessThan(lastStatusAt / 2);
    } finally {
        await teardown();
    }
}, 60000);
