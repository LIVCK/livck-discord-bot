/**
 * A Redis outage must degrade the bot, not stop it.
 *
 * node-redis queues commands issued while the connection is down, and the promise it returns
 * does not settle until the connection returns. The lock read is the first `await` on every
 * status page, so with Redis unreachable that read never settled, `Promise.allSettled` never
 * settled, the cycle never finished, and the `setTimeout` that schedules the next one never
 * ran. Measured against a dead port: `cache.get()` had not resolved after 8 seconds.
 *
 * The bot stayed logged in and kept answering slash commands the whole time, while every
 * subscriber's status embed silently froze at whatever it last showed — through a real
 * incident, for the whole outage, with nothing written to the log.
 */

import { jest } from '@jest/globals';

const redis = { calls: [], behaviour: 'ok' };

jest.unstable_mockModule('../../database/redis.js', () => ({
    default: {
        set: async (key, _value, options) => {
            redis.calls.push({ key, options });
            if (redis.behaviour === 'hangs') return new Promise(() => {});
            if (redis.behaviour === 'throws') throw new Error('connection refused');
            if (redis.behaviour === 'taken') return null;
            return 'OK';
        },
        get: async () => null,
    },
}));

const handled = { status: 0, alerts: 0 };

jest.unstable_mockModule('../../handlers/handleStatuspage.js', () => ({
    handleStatusPage: async () => { handled.status += 1; }, default: {},
}));
jest.unstable_mockModule('../../handlers/handleAlerts.js', () => ({
    handleAlerts: async () => { handled.alerts += 1; }, default: {},
}));
jest.unstable_mockModule('../../models/index.js', () => ({
    default: { Statuspage: { findAll: async () => [] } },
}));
jest.unstable_mockModule('../../services/statuspagePauseManager.js', () => ({
    default: { handleSuccess: async () => false, handleFailure: async () => ({ level: 1, notified: false }) },
    NOTIFY_AT_LEVEL: 4,
    BACKOFF_LADDER_MS: [1000],
}));

const { processStatuspage } = await import('../../services/updateLoop.js');

const page = () => ({ id: 42, url: 'https://status.example.com', name: 'Example' });

beforeEach(() => {
    redis.calls = [];
    redis.behaviour = 'ok';
    handled.status = 0;
    handled.alerts = 0;
});

describe('claiming a status page', () => {
    test('is one SET NX EX, taken before any work', async () => {
        // Not a read followed much later by a write: that window was the whole cycle.
        await processStatuspage(page(), {});

        expect(redis.calls).toHaveLength(1);
        expect(redis.calls[0].options).toMatchObject({ NX: true, EX: expect.any(Number) });
        expect(handled.status).toBe(1);
    });

    test('a page already claimed by another cycle is skipped', async () => {
        redis.behaviour = 'taken';

        await expect(processStatuspage(page(), {})).resolves.toEqual({ skipped: true });
        expect(handled.status).toBe(0);
    });

    test('an unreachable Redis polls anyway instead of stopping the bot', async () => {
        redis.behaviour = 'throws';

        await expect(processStatuspage(page(), {})).resolves.toMatchObject({ updated: true });
        expect(handled.status).toBe(1);
    });

    test('a Redis that never answers does not hang the cycle', async () => {
        // The actual production failure: the promise simply never settles.
        redis.behaviour = 'hangs';

        const result = await Promise.race([
            processStatuspage(page(), {}),
            new Promise((resolve) => setTimeout(() => resolve('HUNG'), 6000)),
        ]);

        expect(result).not.toBe('HUNG');
        expect(handled.status).toBe(1);
    }, 15000);
});
