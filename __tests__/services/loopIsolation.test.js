/**
 * One channel that misbehaves must not hold up anybody else.
 *
 * In production the summary line of the update loop went quiet for twenty to fifty minutes
 * at a time while Discord kept counting invalid requests, and an incident took ten minutes to
 * reach a channel. Two things in the code allow that:
 *
 *  - The cycle waits for its slowest page before the next one is scheduled. Pages run in
 *    parallel inside a cycle, but none of them is looked at again until all of them are done.
 *  - Inside a page the subscriptions are delivered one after the other. The channel after a
 *    stuck one waits for it.
 *
 * And something can stay stuck for that long: @discordjs/rest answers a 429 by sleeping and
 * retrying, with no limit on how often, and without emitting `rateLimited`. The promise the
 * handler awaits settles when Discord stops saying 429 and not before.
 *
 * Nothing here is mocked below the Discord client. It is a real discord.js client talking HTTP
 * to __tests__/fixtures/fakeDiscord.js, so its queues, its 429 handling and its timeouts are
 * the real ones.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { jest } from '@jest/globals';
import { Client } from 'discord.js';
import { startFakeDiscord } from '../fixtures/fakeDiscord.js';
import { createMemoryModels } from '../fixtures/memoryModels.js';

/** What a single delivery to one channel may take. Production: 10s. */
process.env.DISCORD_DELIVERY_TIMEOUT_MS = '1000';
/** First step of a failing channel's backoff. Production: 30s. */
process.env.DELIVERY_BACKOFF_BASE_MS = '300';

const CORPUS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/corpus');
const corpus = (file) => JSON.parse(fs.readFileSync(path.join(CORPUS, file), 'utf8'));

const memory = createMemoryModels();

/** pageId → snapshot the provider hands out */
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
const { resetDelivery } = await import('../../util/delivery.js');

const GREEN = corpus('cloud-01-all-green.json');
const ONE_DOWN = corpus('cloud-02-single-outage.json');

const snapshotOf = (payload) => toSnapshot(payload, { url: 'https://fake.example', name: 'Fake' });

/** The corpus alert, moved into the present: the bot ignores anything older than three days. */
const withFreshAlert = (payload) => {
    const snapshot = snapshotOf(payload);
    const now = new Date().toISOString();
    return {
        ...snapshot,
        alerts: snapshot.alerts.slice(0, 1).map((alert) => ({ ...alert, startedAt: now })),
    };
};

/**
 * Page and channel ids are unique per test. util/pageLock.js queues per page id for the life
 * of the module, and a request a previous test left stuck in discord.js would otherwise still
 * be in the way of the next one.
 */
let serial = 0;
const ids = () => {
    serial += 1;
    return {
        page: 1000 + serial,
        channel: (n) => String(1400000000000000000n + BigInt(serial * 100 + n)),
    };
};

let fake;
let client;
let policy;
/** Cycles started by a test, so teardown can wait for them once Discord is released. */
let running;

const startCycle = () => {
    const cycle = runCycle(client);
    running.push(cycle);
    return cycle;
};

/** Resolves with `value`, or with 'TIMEOUT' after `ms`. */
const within = (promise, ms) => {
    let timer;
    return Promise.race([
        promise.then(() => 'DONE'),
        new Promise((resolve) => { timer = setTimeout(() => resolve('TIMEOUT'), ms); }),
    ]).finally(() => clearTimeout(timer));
};

/** Poll until `check()` is truthy or `ms` passed. */
const eventually = async (check, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        if (check()) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return Boolean(check());
};

beforeEach(async () => {
    memory.reset();
    snapshots.clear();
    running = [];

    resetDelivery();

    fake = await startFakeDiscord();
    // The production REST policy, not the library defaults: what is under test is how the
    // bot as configured behaves. See discord/restPolicy.js.
    policy = createRestPolicy({ log: () => {} });
    client = new Client({ intents: [], rest: { ...policy.options, api: fake.api } });
    policy.attach(client.rest);
    client.rest.setToken('fake-token');
    // In production the gateway fills this in; without a guild discord.js does not build a
    // text channel from what `GET /channels/:id` returns.
    client.guilds._add({ id: fake.guildId, name: 'Fake Guild', channels: [], roles: [], members: [] });

    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
    fake.release();
    // Whatever the bot still has in flight finishes against a Discord that answers again.
    await within(Promise.allSettled(running), 20000);
    policy.stop();
    client.destroy();
    await fake.close();
    jest.restoreAllMocks();
});

describe.each([
    ['rate limited on every request', 'rateLimited'],
    ['never answering', 'hang'],
])('a channel %s', (_label, behaviour) => {
    test('does not keep the cycle from finishing', async () => {
        const { page, channel } = ids();
        memory.addPage({ id: page, url: 'https://stuck.example', name: 'Stuck' });
        memory.subscribe({ id: page * 10 + 1, statuspageId: page, channelId: channel(1) });
        snapshots.set(page, snapshotOf(GREEN));
        fake.script(channel(1), behaviour);

        expect(await within(startCycle(), 4000)).toBe('DONE');
    }, 30000);

    test('does not hold up the next channel of the same page', async () => {
        const { page, channel } = ids();
        memory.addPage({ id: page, url: 'https://shared.example', name: 'Shared' });
        memory.subscribe({ id: page * 10 + 1, statuspageId: page, channelId: channel(1) });
        memory.subscribe({ id: page * 10 + 2, statuspageId: page, channelId: channel(2) });
        snapshots.set(page, snapshotOf(GREEN));
        fake.script(channel(1), behaviour);

        startCycle();

        expect(await eventually(() => fake.messagesIn(channel(2)).length === 1, 4000)).toBe(true);
    }, 30000);

    test('does not delay the next update of a different page', async () => {
        const { page, channel } = ids();
        const other = page + 500;
        memory.addPage({ id: page, url: 'https://stuck.example', name: 'Stuck' });
        memory.addPage({ id: other, url: 'https://healthy.example', name: 'Healthy' });
        memory.subscribe({ id: page * 10 + 1, statuspageId: page, channelId: channel(1) });
        memory.subscribe({ id: other * 10 + 1, statuspageId: other, channelId: channel(2) });
        snapshots.set(page, snapshotOf(GREEN));
        snapshots.set(other, snapshotOf(GREEN));
        fake.script(channel(1), behaviour);

        // Cycle 1 posts the healthy page in parallel with the stuck one; that part already works.
        startCycle();
        expect(await eventually(() => fake.messagesIn(channel(2)).length === 1, 4000)).toBe(true);

        // A service goes down on the healthy page. The next cycle has to show it.
        snapshots.set(other, snapshotOf(ONE_DOWN));
        expect(await within(running[0], 4000)).toBe('DONE');
        startCycle();

        expect(await eventually(() => fake.requests(channel(2), { method: 'PATCH', status: 200 }).length === 1, 4000))
            .toBe(true);
    }, 30000);

    test('does not hold up an alert to the next channel of the same page', async () => {
        const { page, channel } = ids();
        memory.addPage({ id: page, url: 'https://incident.example', name: 'Incident' });
        for (const n of [1, 2]) {
            memory.subscribe({
                id: page * 10 + n,
                statuspageId: page,
                channelId: channel(n),
                eventTypes: { STATUS: false, NEWS: true },
            });
        }
        snapshots.set(page, withFreshAlert(ONE_DOWN));
        fake.script(channel(1), behaviour);

        startCycle();

        // The announcement and its replies: at least the announcement, in time.
        expect(await eventually(() => fake.messagesIn(channel(2)).length >= 1, 4000)).toBe(true);
    }, 30000);
});

describe('Discord saying "not now"', () => {
    test('a channel that is rate limited costs a few invalid requests, not one per retry', async () => {
        const { page, channel } = ids();
        memory.addPage({ id: page, url: 'https://limited.example', name: 'Limited' });
        memory.subscribe({ id: page * 10 + 1, statuspageId: page, channelId: channel(1) });
        snapshots.set(page, snapshotOf(GREEN));
        fake.script(channel(1), 'rateLimited');

        // Twenty cycles in two seconds. discord.js on its own retried a 429 every
        // `retry_after` — four times a second here — for as long as it lasted.
        for (let i = 0; i < 20; i += 1) {
            await within(startCycle(), 4000);
            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        expect(fake.invalidRequests().length).toBeLessThanOrEqual(4);
    }, 30000);

    test('an alert with more updates than a channel takes at once arrives whole, and costs nothing', async () => {
        const { page, channel } = ids();
        memory.addPage({ id: page, url: 'https://busy.example', name: 'Busy' });
        memory.subscribe({
            id: page * 10 + 1,
            statuspageId: page,
            channelId: channel(1),
            eventTypes: { STATUS: false, NEWS: true },
        });

        // One announcement and seven updates: eight messages into one channel, where Discord
        // allows five per five seconds. discord.js spaces them out from the bucket headers by
        // itself, which is waiting it predicted and costs no invalid requests. The bot must let
        // it wait rather than give up on the sixth.
        const base = withFreshAlert(ONE_DOWN);
        const [alert] = base.alerts;
        const updates = Array.from({ length: 7 }, (_, n) => ({
            ...alert.updates[0],
            id: `${alert.updates[0].id}-${n}`,
            createdAt: new Date(Date.now() + n * 1000).toISOString(),
        }));
        snapshots.set(page, { ...base, alerts: [{ ...alert, updates }] });

        startCycle();
        expect(await eventually(() => fake.messagesIn(channel(1)).length === 8, 15000)).toBe(true);

        // A few more cycles once it has all landed: nothing further goes out.
        for (let i = 0; i < 3; i += 1) await within(startCycle(), 4000);

        expect(fake.requests(channel(1), { method: 'POST' })).toHaveLength(8);
        expect(fake.invalidRequests()).toHaveLength(0);
    }, 30000);
});

describe('a channel the bot may not post in (50013)', () => {
    test('is not asked again on every cycle', async () => {
        const { page, channel } = ids();
        memory.addPage({ id: page, url: 'https://locked.example', name: 'Locked' });
        memory.subscribe({ id: page * 10 + 1, statuspageId: page, channelId: channel(1) });
        snapshots.set(page, snapshotOf(GREEN));
        fake.script(channel(1), 'forbidden');

        // Ten cycles is two and a half minutes of production. Every one of them used to send
        // the same refused request again, and each counts towards Discord's IP ban.
        for (let i = 0; i < 10; i += 1) await startCycle();

        expect(fake.requests(channel(1), { status: 403 }).length).toBeLessThanOrEqual(2);
        // It is not a channel that is gone: the subscription stays.
        expect(memory.db.subscriptions).toHaveLength(1);
    }, 30000);

    test('is delivered to again once the permission is back', async () => {
        const { page, channel } = ids();
        memory.addPage({ id: page, url: 'https://locked.example', name: 'Locked' });
        memory.subscribe({ id: page * 10 + 1, statuspageId: page, channelId: channel(1) });
        snapshots.set(page, snapshotOf(GREEN));
        fake.script(channel(1), 'forbidden');
        await startCycle();

        fake.release();

        // Not within the next cycle necessarily, but not never.
        for (let i = 0; i < 40 && fake.messagesIn(channel(1)).length === 0; i += 1) {
            await startCycle();
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(fake.messagesIn(channel(1))).toHaveLength(1);
    }, 30000);
});

describe('an answer that arrives after the bot stopped waiting', () => {
    test('is not followed by a second post of the same message', async () => {
        const { page, channel } = ids();
        memory.addPage({ id: page, url: 'https://slow.example', name: 'Slow' });
        memory.subscribe({ id: page * 10 + 1, statuspageId: page, channelId: channel(1) });
        snapshots.set(page, snapshotOf(GREEN));
        // Longer than the delivery timeout, so a bot that gives up on it and retries posts twice.
        fake.script(channel(1), { delayMs: 2500 });

        // The bot gives up after a second; the request is still out.
        await within(startCycle(), 6000);
        // A cycle while it is still out must not start a second one.
        await within(startCycle(), 6000);

        // Every request is delayed, so the post lands after two delays.
        expect(await eventually(() => fake.messagesIn(channel(1)).length > 0, 8000)).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 100));

        // And once it has landed, the row it wrote is what the next cycle edits or leaves alone.
        await within(startCycle(), 6000);
        await within(startCycle(), 6000);

        expect(fake.requests(channel(1), { method: 'POST' })).toHaveLength(1);
        expect(fake.messagesIn(channel(1))).toHaveLength(1);
        expect(memory.db.messages.filter((m) => m.category === 'STATUS')).toHaveLength(1);
    }, 30000);
});
