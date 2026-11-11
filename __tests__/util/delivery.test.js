/**
 * util/delivery.js on its own: the deadline, the one-at-a-time rule and the backoff.
 * How they play together with discord.js is in __tests__/services/loopIsolation.test.js.
 */

process.env.DISCORD_DELIVERY_TIMEOUT_MS = '100';
process.env.DELIVERY_BACKOFF_BASE_MS = '1000';
process.env.DISCORD_DELIVERY_SLOTS = '3';

const {
    deliver, forgetGuild, forEachLimited, resetDelivery, DeliveryTimeout, drainDeliveries, queuedDeliveries,
    busyDeliverySlots, logDeliveryFailure,
} = await import('../../util/delivery.js');
const { default: logger } = await import('../../util/logger.js');

/**
 * Ids are fresh per test: a delivery an earlier test left running still reports its outcome
 * when it finishes, and a late success clears the backoff of whatever has the same id.
 */
let base = 0;
const sub = (n = 1, guildId = 'g1') => ({ id: base + n, guildId, channelId: `c${base + n}` });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const refused = () => Object.assign(new Error('Missing Permissions'), { code: 50013, status: 403 });

beforeEach(() => {
    resetDelivery();
    base += 100;
});

describe('deliver', () => {
    test('returns what the delivery returned', async () => {
        await expect(deliver(sub(), 'status', async () => 'created')).resolves.toEqual({ status: 'done', value: 'created' });
    });

    test('stops waiting at the deadline and says so', async () => {
        const error = await deliver(sub(), 'status', () => sleep(1000)).catch((e) => e);

        expect(error).toBeInstanceOf(DeliveryTimeout);
        expect(error.retryInMs).toBe(1000);
    });

    test('does not start a second delivery while the first is still out', async () => {
        let calls = 0;
        const slow = () => { calls += 1; return sleep(300); };

        await deliver(sub(), 'status', slow).catch(() => {});
        await expect(deliver(sub(), 'status', slow)).resolves.toEqual({ status: 'busy' });
        expect(calls).toBe(1);
    });

    test('keeps status and alerts apart', async () => {
        const hold = deliver(sub(), 'status', () => sleep(50));
        await expect(deliver(sub(), 'alerts', async () => 'ok')).resolves.toMatchObject({ status: 'done' });
        await hold;
    });

    test('a refused channel sits out its backoff', async () => {
        await expect(deliver(sub(), 'status', async () => { throw refused(); })).rejects.toMatchObject({ code: 50013 });

        let called = false;
        const outcome = await deliver(sub(), 'status', async () => { called = true; });

        expect(outcome.status).toBe('backoff');
        expect(called).toBe(false);
    });

    test('a success in one lane leaves the other lane\'s backoff alone', async () => {
        // The status lane "succeeds" without a single request whenever the embed is unchanged.
        // Sharing one backoff, that reset the ladder the alert lane had just climbed, and a
        // channel refusing every alert was asked again every 30 seconds for ever.
        // Concurrently, as the loop runs them: the alert is refused, then the unchanged status
        // finishes.
        await Promise.all([
            deliver(sub(), 'alerts', async () => { throw refused(); }).catch(() => {}),
            deliver(sub(), 'status', async () => { await sleep(20); return 'skipped'; }),
        ]);

        await expect(deliver(sub(), 'alerts', async () => {})).resolves.toMatchObject({ status: 'backoff' });
    });

    test('the backoff grows with every failure in a row', async () => {
        process.env.DELIVERY_BACKOFF_BASE_MS = '10';
        try {
            const waits = [];
            for (let i = 0; i < 6; i += 1) {
                const error = await deliver(sub(), 'status', async () => { throw refused(); }).catch((e) => e);
                waits.push(error.retryInMs);
                await sleep(error.retryInMs + 30);
            }
            // 1, 2, 4, 10, 20 times the base, then it stays at the top.
            expect(waits).toEqual([10, 20, 40, 100, 200, 200]);
        } finally {
            process.env.DELIVERY_BACKOFF_BASE_MS = '1000';
        }
    });

    test('a late success clears the backoff the timeout started', async () => {
        await deliver(sub(), 'status', () => sleep(200)).catch(() => {});
        await sleep(250);

        await expect(deliver(sub(), 'status', async () => 'ok')).resolves.toMatchObject({ status: 'done' });
    });

    test('a late failure after a timeout is one failure, not two', async () => {
        process.env.DELIVERY_BACKOFF_BASE_MS = '10';
        try {
            await deliver(sub(), 'status', async () => { await sleep(150); throw refused(); }).catch(() => {});
            await sleep(200);
            const error = await deliver(sub(), 'status', async () => { throw refused(); }).catch((e) => e);
            // Second failure: 2 × base. Counted twice it would be 4 ×.
            expect(error.retryInMs).toBe(20);
        } finally {
            process.env.DELIVERY_BACKOFF_BASE_MS = '1000';
        }
    });

    test('an interaction in the guild clears the backoff of its subscriptions only', async () => {
        await deliver(sub(1, 'g1'), 'status', async () => { throw refused(); }).catch(() => {});
        await deliver(sub(2, 'g2'), 'status', async () => { throw refused(); }).catch(() => {});

        await deliver(sub(1, 'g1'), 'alerts', async () => { throw refused(); }).catch(() => {});

        forgetGuild('g1');

        await expect(deliver(sub(1, 'g1'), 'alerts', async () => {})).resolves.toMatchObject({ status: 'done' });

        await expect(deliver(sub(1, 'g1'), 'status', async () => {})).resolves.toMatchObject({ status: 'done' });
        await expect(deliver(sub(2, 'g2'), 'status', async () => {})).resolves.toMatchObject({ status: 'backoff' });
    });
});

describe('the slots shared by every page', () => {
    // discord.js queues whatever goes over Discord's 50 requests per second itself, and a
    // request waiting there runs down the same deadline as a channel that does not answer.
    // In a burst every channel timed out — see __tests__/services/loopBurst.test.js.

    test('no more deliveries run at once than there are slots', async () => {
        let running = 0;
        let peak = 0;
        const work = async () => { running += 1; peak = Math.max(peak, running); await sleep(20); running -= 1; };

        await Promise.all(Array.from({ length: 10 }, (_, i) => deliver(sub(i), 'status', work)));

        expect(peak).toBe(3);
    });

    test('the deadline starts when a delivery gets its slot, not when it is queued', async () => {
        // Six of 250ms each through three slots: the last ones wait 250ms before they start and
        // finish at 500ms, past the 400ms deadline — and none of them was slow. Wide margins on
        // purpose: each one has 150ms to spare, so a slow machine does not fail it.
        process.env.DISCORD_DELIVERY_TIMEOUT_MS = '400';
        try {
            const outcomes = await Promise.all(Array.from({ length: 6 }, (_, i) =>
                deliver(sub(i), 'status', () => sleep(250)).then((o) => o.status, (e) => e.name)));

            expect(outcomes).toEqual(Array(6).fill('done'));
        } finally {
            process.env.DISCORD_DELIVERY_TIMEOUT_MS = '100';
        }
    });

    test('alerts go before status edits that were queued first', async () => {
        const order = [];
        const hold = Array.from({ length: 3 }, (_, i) => deliver(sub(i), 'status', () => sleep(30)));
        const status = deliver(sub(10), 'status', async () => { order.push('status'); });
        const alert = deliver(sub(11), 'alerts', async () => { order.push('alert'); });

        await Promise.all([...hold, status, alert]);

        expect(order).toEqual(['alert', 'status']);
    });

    test('a channel that never answers gives its slot back at the deadline', async () => {
        const hung = Array.from({ length: 3 }, (_, i) =>
            deliver(sub(i), 'status', () => new Promise(() => {})).catch((e) => e.name));

        const after = await deliver(sub(10), 'status', async () => 'through');

        expect(after).toEqual({ status: 'done', value: 'through' });
        expect(await Promise.all(hung)).toEqual(Array(3).fill('DeliveryTimeout'));
    });

    test('a queued delivery counts as in flight, so the next cycle does not queue it twice', async () => {
        const hold = Array.from({ length: 3 }, (_, i) => deliver(sub(i), 'status', () => sleep(30)));
        const first = deliver(sub(10), 'status', async () => 'once');

        await expect(deliver(sub(10), 'status', async () => 'twice')).resolves.toEqual({ status: 'busy' });
        expect(queuedDeliveries()).toBe(1);

        await Promise.all([...hold, first]);
        expect(queuedDeliveries()).toBe(0);
    });

    test('a shutdown does not start what is still queued', async () => {
        // drainDeliveries runs right before the database closes. Starting a queued delivery
        // then is the post-without-a-row this drain exists to prevent.
        let started = 0;
        const hold = Array.from({ length: 3 }, (_, i) => deliver(sub(i), 'status', () => sleep(30)));
        const queued = deliver(sub(10), 'status', async () => { started += 1; });

        await drainDeliveries();

        expect(started).toBe(0);
        await expect(queued).resolves.toEqual({ status: 'cancelled' });
        await Promise.all(hold);
    });

    test('a delivery that timed out gives its slot back once, not again when it finishes', async () => {
        // Released at the deadline, so a channel that never answers does not keep a slot —
        // and NOT a second time when the request does come back. Twice, and the count drifts
        // below what is really out, and the limit quietly stops limiting.
        const late = await deliver(sub(1), 'status', () => sleep(250)).catch((e) => e);
        expect(late).toBeInstanceOf(DeliveryTimeout);
        expect(busyDeliverySlots()).toBe(0);

        await sleep(300);
        expect(busyDeliverySlots()).toBe(0);

        // And the limit still holds afterwards.
        let running = 0;
        let peak = 0;
        const work = async () => { running += 1; peak = Math.max(peak, running); await sleep(20); running -= 1; };
        await Promise.all(Array.from({ length: 8 }, (_, i) => deliver(sub(10 + i), 'status', work)));
        expect(peak).toBe(3);
    });
});

describe('shutting down', () => {
    test('waits for a delivery that outlived its deadline', async () => {
        // The handler stopped waiting for it; the request did not stop. Closing the database
        // under it would post a message whose row is never written.
        let finished = false;
        await deliver(sub(), 'status', async () => { await sleep(250); finished = true; }).catch(() => {});
        expect(finished).toBe(false);

        await drainDeliveries();

        expect(finished).toBe(true);
    });

    test('starts nothing that asks after the drain began', async () => {
        // A page that overran its deadline is still running when the shutdown drains, and can
        // reach deliver() afterwards. That delivery would land after the drain's snapshot.
        const drained = drainDeliveries();
        let called = false;

        await expect(deliver(sub(), 'alerts', async () => { called = true; })).resolves.toEqual({ status: 'cancelled' });
        await drained;
        expect(called).toBe(false);
    });
});

describe('the line a failed delivery writes', () => {
    test('says what a rate limit is, when the error carries no message of its own', () => {
        // RateLimitError from @discordjs/rest has an empty message; the line read "(…): , next".
        const lines = [];
        const original = logger.once;
        logger.once = (_key, _level, line) => { lines.push(line); };
        try {
            const error = Object.assign(new Error(''), { name: 'RateLimitError[/channels/:id/messages]', timeToReset: 3000, global: false, scope: 'user', retryInMs: 60_000 });
            logDeliveryFailure('handleAlerts', 'alerts', sub(), error);
        } finally {
            logger.once = original;
        }
        expect(lines[0]).toMatch(/: rate limited by Discord \(user, 3s\), next attempt in 60s$/);
    });
});

describe('forEachLimited', () => {
    test('runs every item, never more than the limit at once', async () => {
        let running = 0;
        let peak = 0;
        const seen = [];

        await forEachLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
            running += 1;
            peak = Math.max(peak, running);
            await sleep(10);
            seen.push(n);
            running -= 1;
        });

        expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
        expect(peak).toBe(3);
    });

    test('an empty list is fine', async () => {
        await expect(forEachLimited([], 3, async () => {})).resolves.toBeUndefined();
    });
});
