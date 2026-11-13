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

const cycle = { calls: 0, throwOnce: false, slowUntil: null, failWith: null, failTimes: 0 };

beforeEach(() => {
    cycle.calls = 0;
    cycle.throwOnce = false;
    cycle.failWith = null;
    cycle.failTimes = 0;
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
                    if (cycle.failTimes > 0) { cycle.failTimes -= 1; throw cycle.failWith(); }
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

describe('a database that is gone for a while', () => {
    /** What Sequelize throws when the host does not resolve, as in production at 22:53. */
    const hostNotFound = () => Object.assign(
        new Error('getaddrinfo ENOTFOUND legacy-db'),
        { name: 'SequelizeHostNotFoundError', parent: new Error('getaddrinfo ENOTFOUND legacy-db') },
    );

    test('is one line for the whole outage, not a stack trace per cycle', async () => {
        // It printed some forty lines of stack per cycle: four a minute for as long as the
        // database stayed away, burying everything else in the log.
        const loop = await loadCounting();
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
        cycle.failWith = hostNotFound;
        cycle.failTimes = 6;

        loop.startUpdateLoop({});
        await advance(loop, 6);
        loop.stopUpdateLoop();

        const lines = errors.mock.calls.map((args) => args.map(String).join(' '));
        errors.mockRestore();

        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('Database unavailable');
        expect(lines[0]).toContain('ENOTFOUND legacy-db');
        expect(lines[0]).not.toContain('    at ');
    });

    test('is reported again if it goes away a second time', async () => {
        const loop = await loadCounting();
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
        cycle.failWith = hostNotFound;

        cycle.failTimes = 2;
        loop.startUpdateLoop({});
        await advance(loop, 4);
        cycle.failTimes = 2;
        await advance(loop, 4);
        loop.stopUpdateLoop();

        const outages = errors.mock.calls.filter((args) => String(args[0]).includes('Database unavailable'));
        errors.mockRestore();
        expect(outages).toHaveLength(2);
    });

    test('anything else still gets its stack', async () => {
        const loop = await loadCounting();
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
        cycle.throwOnce = true;

        loop.startUpdateLoop({});
        await advance(loop, 1);
        loop.stopUpdateLoop();

        const call = errors.mock.calls.find((args) => String(args[0]).includes('Critical error'));
        errors.mockRestore();
        expect(call?.[1]).toBeInstanceOf(Error);
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

        expect(summary).toEqual({ due: 0, updated: 0, skipped: 0, failed: 0, marked: 0, busy: 0, overran: 0 });
    });
});
