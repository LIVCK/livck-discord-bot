/**
 * Applying pending migrations at boot.
 *
 * This runs on every start, before the loop touches a column, and ends the process when it
 * fails. It had no tests at all — which for something in the startup path that can both alter
 * a schema and stop a deployment is the wrong way round.
 *
 * Umzug is stubbed: what matters here is the decision — is anything pending, is it applied, is
 * a failure allowed to pass — not that Umzug can talk to MariaDB, which the migration runs in
 * the end-to-end suites already prove.
 */

import { jest } from '@jest/globals';

const umzug = { pending: [], applied: [], failWith: null, upCalls: 0 };

jest.unstable_mockModule('umzug', () => ({
    Umzug: class {
        async pending() { return umzug.pending; }
        async up() {
            umzug.upCalls += 1;
            if (umzug.failWith) throw umzug.failWith;
            return umzug.applied;
        }
    },
    SequelizeStorage: class {},
}));

jest.unstable_mockModule('../../database/index.js', () => ({
    default: { getQueryInterface: () => ({}) },
}));

const { migrateOnStart } = await import('../../util/migrateOnStart.js');

let logged;

beforeEach(() => {
    umzug.pending = [];
    umzug.applied = [];
    umzug.failWith = null;
    umzug.upCalls = 0;
    logged = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => logged.mockRestore());

describe('at boot', () => {
    test('a current schema costs one question and no writes', () => {
        // The overwhelmingly common case: every restart, forever.
        return migrateOnStart().then((applied) => {
            expect(applied).toEqual([]);
            expect(umzug.upCalls).toBe(0);
        });
    });

    test('pending migrations are applied and named', async () => {
        umzug.pending = [{ name: 'a.js' }, { name: 'b.js' }];
        umzug.applied = [{ name: 'a.js' }, { name: 'b.js' }];

        const applied = await migrateOnStart();

        expect(applied).toEqual(['a.js', 'b.js']);
        expect(umzug.upCalls).toBe(1);

        // Named in the log, because "2 migrations applied" is not something anyone can act on.
        const said = logged.mock.calls.map((c) => c.join(' ')).join('\n');
        expect(said).toContain('a.js');
        expect(said).toContain('b.js');
    });

    test('a failure propagates rather than being swallowed', async () => {
        // server.js turns this into an exit. Swallowing it would start the bot against a
        // schema it cannot use, which fails every query for ever without ever exiting.
        umzug.pending = [{ name: 'a.js' }];
        umzug.failWith = new Error('Duplicate column name');

        await expect(migrateOnStart()).rejects.toThrow('Duplicate column name');
    });

    test('nothing pending means nothing is applied, even if up would succeed', async () => {
        umzug.applied = [{ name: 'should-not-run.js' }];

        expect(await migrateOnStart()).toEqual([]);
        expect(umzug.upCalls).toBe(0);
    });
});
