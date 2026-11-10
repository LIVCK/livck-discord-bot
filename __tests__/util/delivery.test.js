/**
 * util/delivery.js on its own: the deadline, the one-at-a-time rule and the backoff.
 * How they play together with discord.js is in __tests__/services/loopIsolation.test.js.
 */

process.env.DISCORD_DELIVERY_TIMEOUT_MS = '100';
process.env.DELIVERY_BACKOFF_BASE_MS = '1000';

const { deliver, forgetGuild, forEachLimited, resetDelivery, DeliveryTimeout } = await import('../../util/delivery.js');

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
                await sleep(error.retryInMs + 5);
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
