/**
 * The brake on deleting subscriptions.
 *
 * A channel answering 10003 (Unknown Channel) or 50001 (Missing Access) is taken as gone for
 * good and its subscription is deleted — a customer's configuration, with no undo and no
 * record of what it was. That is right for the case it was written for.
 *
 * It is also exactly what a bot sees for EVERY channel when it holds the wrong token. A test
 * bot pointed at the production database deletes every subscription in it, one 10003 at a
 * time, each one looking like an ordinary tidy-up in the log — and that configuration is one
 * `node server.js` away whenever a `.env` carries a new token beside an old database. The
 * same shape appears during a Discord incident that answers 10003 for channels that are fine.
 */

import { jest } from '@jest/globals';
import { mayReap, recordReap, reapCount, resetReaper, REAP_LIMIT } from '../../util/subscriptionReaper.js';

beforeEach(() => resetReaper());

describe('removing subscriptions', () => {
    test('a handful is ordinary life and goes through', () => {
        for (let i = 0; i < 5; i += 1) {
            expect(mayReap()).toBe(true);
            recordReap();
        }

        expect(reapCount()).toBe(5);
    });

    test('stops once the count stops looking like a tidy-up', () => {
        for (let i = 0; i < REAP_LIMIT; i += 1) {
            expect(mayReap()).toBe(true);
            recordReap();
        }

        expect(mayReap()).toBe(false);
    });

    test('stays stopped rather than resuming on the next cycle', () => {
        for (let i = 0; i < REAP_LIMIT; i += 1) { mayReap(); recordReap(); }

        expect(mayReap()).toBe(false);
        expect(mayReap()).toBe(false);
        expect(reapCount()).toBe(REAP_LIMIT);
    });

    test('says so once, not once per refusal', () => {
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});

        try {
            for (let i = 0; i < REAP_LIMIT; i += 1) { mayReap(); recordReap(); }
            for (let i = 0; i < 10; i += 1) mayReap();

            const lines = errors.mock.calls.filter(([first]) => String(first).includes('[Reaper]'));
            expect(lines).toHaveLength(1);
            expect(String(lines[0][0])).toMatch(/right token/i);
        } finally {
            errors.mockRestore();
        }
    });

    test('the limit is well above a normal day and well below a database', () => {
        expect(REAP_LIMIT).toBeGreaterThan(5);
        expect(REAP_LIMIT).toBeLessThan(200);
    });
});
