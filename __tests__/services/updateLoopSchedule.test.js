/**
 * The scheduler, and being able to stop it.
 *
 * `runCycle` is exercised end to end against a real database; the loop AROUND it is not — and
 * that loop is what keeps the process alive. Its timer is the reason a SIGTERM did nothing
 * until today: Node's event loop stays up while a timer is pending, so `docker stop` waited
 * its ten seconds and then SIGKILLed the process, cutting a cycle in half on every deploy.
 * That was measured by hand once (10s/exit 137 before, 183ms/exit 0 after); this is what keeps
 * it measured.
 *
 * Fake timers throughout, so the test does not wait fifteen seconds to find out.
 */

import { jest } from '@jest/globals';

const cycle = { calls: 0, throwOnce: false, slowUntil: null };

beforeEach(() => {
    cycle.calls = 0;
    cycle.throwOnce = false;
    jest.useFakeTimers();
});

afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
});

/**
 * The loop with a counting stand-in for the database.
 *
 * `startUpdateLoop` reaches `runCycle` through the module's own binding, which a spy cannot
 * intercept across an ES module boundary — so cycles are counted in the mocked model, which
 * every one of them reaches. Module state (`stopping`, the pending timer) is reset by
 * re-importing.
 */
const loadCounting = async () => {
    jest.resetModules();

    jest.unstable_mockModule('../../models/index.js', () => ({
        default: {
            Statuspage: {
                findAll: async () => {
                    cycle.calls += 1;
                    if (cycle.throwOnce) { cycle.throwOnce = false; throw new Error('database gone'); }
                    return [];
                },
            },
        },
    }));
    jest.unstable_mockModule('../../database/redis.js', () => ({
        default: { set: async () => 'OK', get: async () => null, del: async () => {} },
    }));
    jest.unstable_mockModule('../../handlers/handleStatuspage.js', () => ({ handleStatusPage: async () => {}, default: {} }));
    jest.unstable_mockModule('../../handlers/handleAlerts.js', () => ({ handleAlerts: async () => {}, default: {} }));
    jest.unstable_mockModule('../../services/statuspagePauseManager.js', () => ({
        default: { handleSuccess: async () => false, handleFailure: async () => ({ level: 1, marked: false }) },
        NOTIFY_AT_LEVEL: 4, BACKOFF_LADDER_MS: [1000],
    }));

    return import('../../services/updateLoop.js');
};

/** Let pending promises settle, then fire the timer, repeatedly. */
const advance = async (loopModule, times) => {
    for (let i = 0; i < times; i += 1) {
        await Promise.resolve();
        await Promise.resolve();
        jest.advanceTimersByTime(loopModule.INTERVAL);
    }
    await Promise.resolve();
    await Promise.resolve();
};

describe('the scheduler', () => {
    test('runs a cycle immediately and then one per interval', async () => {
        const loop = await loadCounting();

        loop.startUpdateLoop({});
        await advance(loop, 3);

        expect(cycle.calls).toBeGreaterThanOrEqual(3);
        loop.stopUpdateLoop();
    });

    test('keeps going after a cycle throws', async () => {
        // A failing cycle must not end the loop — that would silently stop the whole bot.
        const loop = await loadCounting();
        cycle.throwOnce = true;

        loop.startUpdateLoop({});
        await advance(loop, 2);

        expect(cycle.calls).toBeGreaterThanOrEqual(2);
        loop.stopUpdateLoop();
    });
});

describe('stopping', () => {
    test('schedules nothing further', async () => {
        const loop = await loadCounting();

        loop.startUpdateLoop({});
        await advance(loop, 1);
        const atStop = cycle.calls;

        loop.stopUpdateLoop();
        await advance(loop, 5);

        expect(cycle.calls).toBe(atStop);
    });

    test('clears the pending timer, so nothing keeps the process alive', async () => {
        // The whole point: a pending timer is why SIGTERM did nothing and Docker had to kill
        // the process after ten seconds.
        const loop = await loadCounting();

        loop.startUpdateLoop({});
        await advance(loop, 1);
        expect(jest.getTimerCount()).toBeGreaterThan(0);

        loop.stopUpdateLoop();
        expect(jest.getTimerCount()).toBe(0);
    });

    test('a start after a stop does nothing', async () => {
        // Whatever order a shutdown happens in, it stays stopped.
        const loop = await loadCounting();

        loop.stopUpdateLoop();
        loop.startUpdateLoop({});
        await advance(loop, 3);

        expect(cycle.calls).toBe(0);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('stopping twice is harmless', async () => {
        const loop = await loadCounting();

        loop.startUpdateLoop({});
        await advance(loop, 1);

        expect(() => { loop.stopUpdateLoop(); loop.stopUpdateLoop(); }).not.toThrow();
        expect(jest.getTimerCount()).toBe(0);
    });
});

describe('a cycle with nothing due', () => {
    test('returns an empty summary without touching Discord', async () => {
        const loop = await loadCounting();

        const summary = await loop.runCycle({});

        expect(summary).toEqual({ due: 0, updated: 0, skipped: 0, failed: 0, marked: 0 });
    });
});
