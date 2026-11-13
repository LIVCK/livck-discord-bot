/**
 * A page that hangs on something without a deadline of its own.
 *
 * Every Discord request has a deadline (util/delivery.js) and so does every request to a
 * status page (__tests__/api/timeouts.test.js). The page deadline in services/updateLoop.js is
 * what is left when something else hangs — a database query, a lock, a bug — and it was never
 * exercised: in the loop tests the delivery deadline always ended a page first. Without it a
 * single hanging page holds the cycle, and the cycle after it, for as long as it hangs; that
 * is the production stall all of this started with.
 */

import { jest } from '@jest/globals';

process.env.UPDATE_PAGE_DEADLINE_MS = '200';

const pages = [{ id: 1, url: 'https://hangs.example' }, { id: 2, url: 'https://fine.example' }];
const calls = { 1: 0, 2: 0 };
let release;

jest.unstable_mockModule('../../models/index.js', () => ({
    default: { Statuspage: { findAll: async () => pages } },
}));
jest.unstable_mockModule('../../database/redis.js', () => ({
    // The claim always succeeds: what is under test is the loop's own bookkeeping, not the
    // Redis lock in front of it.
    default: { set: async () => 'OK', get: async () => null, del: async () => 1, isOpen: true },
}));
jest.unstable_mockModule('../../handlers/handleStatuspage.js', () => ({
    handleStatusPage: async (id) => {
        calls[id] += 1;
        if (id === 1) await new Promise((resolve) => { release = resolve; });
    },
    default: {},
}));
jest.unstable_mockModule('../../handlers/handleAlerts.js', () => ({ handleAlerts: async () => {}, default: {} }));
jest.unstable_mockModule('../../services/statuspagePauseManager.js', () => ({
    default: { handleSuccess: async () => false, handleFailure: async () => ({ level: 1, marked: false }) },
    NOTIFY_AT_LEVEL: 4,
    BACKOFF_LADDER_MS: [1000],
}));

const { runCycle } = await import('../../services/updateLoop.js');

// Without the deadline a cycle never returns. Fail, rather than hang the suite.
jest.setTimeout(3000);

test('the cycle finishes at the deadline, without the page that hangs', async () => {
    const started = Date.now();
    const summary = await runCycle({});

    expect(Date.now() - started).toBeLessThan(1500);
    expect(summary.overran).toBe(1);
    expect(summary.updated).toBe(1);
});

test('the next cycle leaves the hanging page alone and still serves the other', async () => {
    // Starting the hanging page again would stack a second run on top of the first, and the
    // second would hang too — one more per cycle, for as long as it lasts.
    const summary = await runCycle({});

    expect(summary.busy).toBe(1);
    expect(calls).toEqual({ 1: 1, 2: 2 });
});

test('once it is done, it is picked up again like any other page', async () => {
    release();
    await new Promise((resolve) => setImmediate(resolve));

    const summary = await runCycle({});

    expect(summary.busy).toBe(0);
    expect(calls[1]).toBe(2);
    release();
});
