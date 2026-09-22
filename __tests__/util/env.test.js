/**
 * Saying what is missing, instead of failing somewhere deep.
 *
 * Without this the first symptom of a forgotten REDIS_HOST is `TypeError: Invalid URL` thrown
 * from inside node-redis at IMPORT time — the URL it builds reads
 * `redis://undefined@undefined:undefined` — before any handler exists to catch it. A missing
 * DB_HOST is a socket timeout somewhere in Sequelize. Neither names the variable, and both
 * look like a broken build rather than a missing line in `.env`.
 */

import { missingEnv, REQUIRED } from '../../util/env.js';

const complete = () => ({
    DISCORD_BOT_TOKEN: 'token',
    DISCORD_CLIENT_ID: '123',
    DB_HOST: 'db',
    DB_DATABASE: 'bot',
    DB_USERNAME: 'root',
    REDIS_HOST: 'redis',
    REDIS_PORT: '6379',
});

describe('the configuration a bot cannot start without', () => {
    test('a complete environment reports nothing missing', () => {
        expect(missingEnv(complete())).toEqual([]);
    });

    test.each(REQUIRED)('%s is reported by name when it is absent', (name) => {
        const env = complete();
        delete env[name];

        expect(missingEnv(env)).toEqual([name]);
    });

    test('a blank value counts as missing', () => {
        // `REDIS_HOST=` in a .env file is the realistic mistake, and it produces exactly the
        // same unreadable failure as leaving the line out.
        expect(missingEnv({ ...complete(), REDIS_HOST: '   ' })).toEqual(['REDIS_HOST']);
    });

    test('an empty password is legitimate and is not required', () => {
        // A local MariaDB with no root password, and a Redis with no auth, are both normal.
        expect(REQUIRED).not.toContain('DB_PASSWORD');
        expect(REQUIRED).not.toContain('REDIS_PASSWORD');
        expect(missingEnv({ ...complete(), DB_PASSWORD: '', REDIS_PASSWORD: '' })).toEqual([]);
    });

    test('everything absent is listed at once, not one per restart', () => {
        expect(missingEnv({})).toEqual(REQUIRED);
    });
});
