/**
 * Many pages, many channels, some of them broken, for many cycles.
 *
 * loopIsolation.test.js checks one misbehaving channel at a time. This puts them together the
 * way production does: a dozen pages, three channels each, a seeded share of them refusing,
 * rate limited, silent or slow, while the pages change underneath. What is checked is not any
 * single outcome but what has to hold on EVERY run:
 *
 *   1. every cycle finishes, in bounded time
 *   2. a healthy channel shows its page's current state within two cycles of a change,
 *      whatever its neighbours are doing
 *   3. no channel ever holds a second status message, and no subscription a second row
 *   4. broken channels cost a bounded number of invalid requests, not one per retry
 *   5. once Discord behaves again, every channel converges on the current state
 *
 * SEEDED: SOAK_SEED reproduces a run exactly, SOAK_CYCLES makes it longer when hunting.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { jest } from '@jest/globals';
import { Client } from 'discord.js';
import { startFakeDiscord } from '../fixtures/fakeDiscord.js';
import { createMemoryModels } from '../fixtures/memoryModels.js';

process.env.DISCORD_DELIVERY_TIMEOUT_MS = '1000';
process.env.DELIVERY_BACKOFF_BASE_MS = '100';

const SEED = Number(process.env.SOAK_SEED || 20261110);
const CYCLES = Number(process.env.SOAK_CYCLES || 40);
const PAGES = 12;
const CHANNELS_PER_PAGE = 3;
const PAUSE_MS = 150;

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
const { resetDelivery } = await import('../../util/delivery.js');
const { getLayoutRenderer } = await import('../../messages/layoutRenderers.js');
const { withLocale } = await import('../../util/Translation.js');

/** mulberry32, as in payloadFuzz.test.js. */
const rngFrom = (seed) => {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

const STATES = [
    snapshotOf('cloud-01-all-green.json'),
    snapshotOf('cloud-02-single-outage.json'),
    snapshotOf('cloud-03-degraded-only.json'),
    snapshotOf('cloud-04-maintenance-window.json'),
];

function snapshotOf(file) {
    return toSnapshot(corpus(file), { url: 'https://soak.example', name: 'Soak' });
}

/** The embeds a channel should be showing for a snapshot, without the timestamp. */
const expectedEmbeds = (snapshot) => withLocale('de', () =>
    getLayoutRenderer('COMPACT')(snapshot, 'de').map(({ embed }) => {
        const json = embed.toJSON();
        delete json.timestamp;
        return JSON.stringify(json);
    }));

const shownEmbeds = (message) => (message?.embeds ?? []).map((embed) => {
    const json = { ...embed };
    delete json.timestamp;
    return JSON.stringify(json);
});

const pick = (rng, weighted) => {
    let roll = rng();
    for (const [value, weight] of weighted) {
        if ((roll -= weight) < 0) return value;
    }
    return weighted[weighted.length - 1][0];
};

const within = (promise, ms) => {
    let timer;
    return Promise.race([
        promise.then(() => 'DONE'),
        new Promise((resolve) => { timer = setTimeout(() => resolve('TIMEOUT'), ms); }),
    ]).finally(() => clearTimeout(timer));
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test(`${CYCLES} cycles over ${PAGES} pages with broken channels (seed ${SEED})`, async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const rng = rngFrom(SEED);
    resetDelivery();

    // Time runs about a hundred times faster than in production — 150ms per cycle instead of
    // 15s — so Discord's per-channel bucket of five per five seconds is scaled with it.
    // Unscaled, a status message would be edited more often here than production ever edits
    // one, and the result would measure the compression rather than the bot. The real window
    // is exercised in loopIsolation.test.js, by an alert long enough to need it.
    const fake = await startFakeDiscord({ bucket: { limit: 5, windowSeconds: 0.05 } });
    const policy = createRestPolicy({ log: () => {} });
    const client = new Client({ intents: [], rest: { ...policy.options, api: fake.api } });
    policy.attach(client.rest);
    client.rest.setToken('fake-token');
    client.guilds._add({ id: fake.guildId, name: 'Fake Guild', channels: [], roles: [], members: [] });

    const running = [];
    const problems = [];

    try {
        /** channelId → { page, behaviour } */
        const channels = new Map();
        const state = new Map();

        for (let p = 0; p < PAGES; p += 1) {
            const pageId = 5000 + p;
            memory.addPage({ id: pageId, url: `https://soak-${p}.example`, name: `Soak ${p}` });
            state.set(pageId, 0);
            snapshots.set(pageId, STATES[0]);

            for (let c = 0; c < CHANNELS_PER_PAGE; c += 1) {
                const channelId = String(1500000000000000000n + BigInt(p * 10 + c));
                const behaviour = pick(rng, [
                    ['ok', 0.7], ['forbidden', 0.1], ['rateLimited', 0.08], ['hang', 0.06], [{ delayMs: 1500 }, 0.06],
                ]);
                memory.subscribe({ id: pageId * 10 + c, statuspageId: pageId, channelId });
                channels.set(channelId, { pageId, behaviour });
                if (behaviour !== 'ok') fake.script(channelId, behaviour);
            }
        }

        const healthy = [...channels].filter(([, c]) => c.behaviour === 'ok').map(([id]) => id);
        const broken = channels.size - healthy.length;

        const chaosStartedAt = Date.now();

        /** pageId → the cycle in which its current state was set */
        const changedAt = new Map([...state.keys()].map((id) => [id, 0]));

        for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
            // A third of the pages change state now and then.
            for (const pageId of state.keys()) {
                if (cycle > 2 && rng() < 0.08) {
                    const next = (state.get(pageId) + 1 + Math.floor(rng() * (STATES.length - 1))) % STATES.length;
                    state.set(pageId, next);
                    snapshots.set(pageId, STATES[next]);
                    changedAt.set(pageId, cycle);
                }
            }

            const started = Date.now();
            const cycleRun = runCycle(client);
            running.push(cycleRun);

            // (1) Bounded: the delivery timeout plus a margin, never the slowest channel.
            if (await within(cycleRun, 2500) !== 'DONE') {
                problems.push(`cycle ${cycle} did not finish within 2.5s`);
                break;
            }
            await sleep(Math.max(0, PAUSE_MS - (Date.now() - started)));

            // (2) A healthy channel is at most two cycles behind its page.
            for (const channelId of healthy) {
                const { pageId } = channels.get(channelId);
                if (cycle - changedAt.get(pageId) < 2) continue;

                const [message, ...extra] = fake.messagesIn(channelId);
                if (extra.length > 0) problems.push(`cycle ${cycle}: ${channelId} holds ${extra.length + 1} messages`);
                if (JSON.stringify(shownEmbeds(message)) !== JSON.stringify(expectedEmbeds(snapshots.get(pageId)))) {
                    problems.push(`cycle ${cycle}: healthy ${channelId} still shows an old state of page ${pageId}`);
                }
            }

            if (problems.length > 0) break;
        }

        // (3) No duplicates anywhere, broken channels included.
        for (const channelId of channels.keys()) {
            if (fake.messagesIn(channelId).length > 1) problems.push(`${channelId} holds a second status message`);
        }
        const rows = memory.db.messages.filter((m) => m.category === 'STATUS');
        if (new Set(rows.map((r) => r.subscriptionId)).size !== rows.length) {
            problems.push('a subscription has more than one STATUS row');
        }

        // (4) Derived from the ladder in util/delivery.js, not picked: base × [1, 2, 4, 10, 20],
        // so five attempts in the first 3.7 base-units of time and one per 20 after that. Two
        // invalid requests per attempt at most (the channel lookup and the post). Without the
        // backoff this was one attempt per channel per CYCLE, and with discord.js's own retry
        // one per retry_after on top of that.
        const base = Number(process.env.DELIVERY_BACKOFF_BASE_MS);
        const elapsed = Date.now() - chaosStartedAt;
        const attempts = 5 + Math.ceil(Math.max(0, elapsed - 37 * base) / (20 * base)) + 1;
        const budget = broken * attempts * 2;
        const invalid = fake.invalidRequests().length;
        if (invalid > budget) problems.push(`${invalid} invalid requests for ${broken} broken channels (budget ${budget})`);
        if (invalid > broken * CYCLES / 2) problems.push(`${invalid} invalid requests: as many as without any backoff`);

        // (5) Discord behaves again: everything converges.
        fake.release();
        await within(Promise.allSettled(running), 20000);
        for (let i = 0; i < 30; i += 1) {
            const converged = [...channels].every(([channelId, { pageId }]) => {
                const shown = fake.messagesIn(channelId);
                return shown.length === 1
                    && JSON.stringify(shownEmbeds(shown[0])) === JSON.stringify(expectedEmbeds(snapshots.get(pageId)));
            });
            if (converged) break;
            const cycleRun = runCycle(client);
            running.push(cycleRun);
            await within(cycleRun, 5000);
            await sleep(250);
            if (i === 29) problems.push('channels did not converge after Discord recovered');
        }
        for (const channelId of channels.keys()) {
            if (fake.messagesIn(channelId).length !== 1) {
                problems.push(`${channelId} ends with ${fake.messagesIn(channelId).length} messages`);
            }
        }

        if (problems.length > 0) {
            throw new Error(`seed ${SEED} (rerun with SOAK_SEED=${SEED}):\n  ${problems.slice(0, 10).join('\n  ')}`);
        }
    } finally {
        fake.release();
        await within(Promise.allSettled(running), 20000);
        policy.stop();
        client.destroy();
        await fake.close();
        jest.restoreAllMocks();
    }
}, 120000);
