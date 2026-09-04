import { jest } from '@jest/globals';
import logger, { refreshLevel } from '../../util/logger.js';
import { HttpError } from '../../util/errors.js';

/** Capture console output for one call. */
const capture = (fn) => {
    const lines = { log: [], warn: [], error: [] };
    const originals = { log: console.log, warn: console.warn, error: console.error };

    console.log = (...args) => lines.log.push(args);
    console.warn = (...args) => lines.warn.push(args);
    console.error = (...args) => lines.error.push(args);

    try {
        fn();
    } finally {
        Object.assign(console, originals);
    }

    return lines;
};

const withLevel = (level, fn) => {
    const previous = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = level;
    refreshLevel();
    try {
        return fn();
    } finally {
        if (previous === undefined) delete process.env.LOG_LEVEL;
        else process.env.LOG_LEVEL = previous;
        refreshLevel();
    }
};

afterEach(() => refreshLevel());

describe('levels', () => {
    test('info hides debug', () => {
        const lines = withLevel('info', () => capture(() => {
            logger.debug('per-page chatter');
            logger.info('cycle summary');
        }));

        expect(lines.log).toHaveLength(1);
        expect(lines.log[0][0]).toBe('cycle summary');
    });

    test('debug shows everything', () => {
        const lines = withLevel('debug', () => capture(() => {
            logger.debug('a');
            logger.info('b');
        }));

        expect(lines.log).toHaveLength(2);
    });

    test('error hides warnings', () => {
        const lines = withLevel('error', () => capture(() => {
            logger.warn('quiet');
            logger.error('loud');
        }));

        expect(lines.warn).toHaveLength(0);
        expect(lines.error).toHaveLength(1);
    });

    test('an unknown LOG_LEVEL falls back to info in production, not to silence', () => {
        // A typo in the deployed env must not turn the bot mute.
        const previousEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';

        try {
            const lines = withLevel('nonsense', () => capture(() => {
                logger.info('still visible');
                logger.debug('but not this');
            }));

            expect(lines.log).toHaveLength(1);
            expect(lines.log[0][0]).toBe('still visible');
        } finally {
            process.env.NODE_ENV = previousEnv;
            refreshLevel();
        }
    });

    test('tests default to error so Jest output stays about the tests', () => {
        const previous = process.env.LOG_LEVEL;
        delete process.env.LOG_LEVEL;
        refreshLevel();

        try {
            const lines = capture(() => {
                logger.warn('suppressed in tests');
                logger.error('always shown');
            });

            expect(lines.warn).toHaveLength(0);
            expect(lines.error).toHaveLength(1);
        } finally {
            if (previous !== undefined) process.env.LOG_LEVEL = previous;
            refreshLevel();
        }
    });
});

describe('once', () => {
    test('the same message under the same key is logged only the first time', () => {
        const key = `test:${Math.random()}`;

        const lines = withLevel('warn', () => capture(() => {
            for (let i = 0; i < 100; i += 1) logger.once(key, 'warn', 'domain does not resolve');
        }));

        expect(lines.warn).toHaveLength(1);
    });

    test('a changed message gets through', () => {
        const key = `test:${Math.random()}`;

        const lines = withLevel('warn', () => capture(() => {
            logger.once(key, 'warn', 'DNS');
            logger.once(key, 'warn', 'DNS');
            logger.once(key, 'warn', 'HTTP 500');
        }));

        expect(lines.warn).toHaveLength(2);
    });

    test('different keys do not suppress each other', () => {
        const lines = withLevel('warn', () => capture(() => {
            logger.once(`a:${Math.random()}`, 'warn', 'same text');
            logger.once(`b:${Math.random()}`, 'warn', 'same text');
        }));

        expect(lines.warn).toHaveLength(2);
    });

    test('resetOnce makes the next occurrence log again', () => {
        const key = `test:${Math.random()}`;

        const lines = withLevel('warn', () => capture(() => {
            logger.once(key, 'warn', 'DNS');
            logger.once(key, 'warn', 'DNS');
            logger.resetOnce(key);
            logger.once(key, 'warn', 'DNS');
        }));

        expect(lines.warn).toHaveLength(2);
    });

    test('reports whether it actually logged', () => {
        const key = `test:${Math.random()}`;

        withLevel('warn', () => capture(() => {
            expect(logger.once(key, 'warn', 'x')).toBe(true);
            expect(logger.once(key, 'warn', 'x')).toBe(false);
        }));
    });
});

describe('failure', () => {
    test('a routine network failure is one line with no stack', () => {
        const error = new Error('fetch failed');
        error.cause = { code: 'ENOTFOUND' };

        const lines = withLevel('warn', () => capture(() => logger.failure('[Loop]', 'https://x.test', error)));

        expect(lines.warn).toHaveLength(1);
        expect(lines.warn[0]).toHaveLength(1);            // message only, no error object
        expect(lines.warn[0][0]).toContain('DNS');
        expect(lines.error).toHaveLength(0);
    });

    test('an HTTP status is named in the line', () => {
        const lines = withLevel('warn', () => capture(
            () => logger.failure('[Loop]', 'https://x.test', new HttpError(503, 'Unavailable'))
        ));

        expect(lines.warn[0][0]).toContain('HTTP_5XX');
        expect(lines.warn[0][0]).toContain('503');
    });

    test('an unexpected error keeps its stack', () => {
        // A programming mistake must not be hidden by the same suppression that keeps a dead
        // customer domain out of the log.
        const lines = withLevel('warn', () => capture(
            () => logger.failure('[Loop]', 'https://x.test', new TypeError('x.y is not a function'))
        ));

        expect(lines.error).toHaveLength(1);
        expect(lines.error[0]).toHaveLength(2);           // message AND the error object
    });

    test('repeats for the same page are suppressed when a dedupe key is given', () => {
        // This is what turns a dead domain from ~5760 log entries a day into a handful.
        const key = `fetch:${Math.random()}`;
        const error = new Error('fetch failed');
        error.cause = { code: 'ENOTFOUND' };

        const lines = withLevel('warn', () => capture(() => {
            for (let i = 0; i < 200; i += 1) logger.failure('[Loop]', 'https://x.test', error, key);
        }));

        expect(lines.warn).toHaveLength(1);
    });

    test('without a dedupe key every occurrence is logged', () => {
        const error = new Error('fetch failed');
        error.cause = { code: 'ENOTFOUND' };

        const lines = withLevel('warn', () => capture(() => {
            logger.failure('[Loop]', 'https://x.test', error);
            logger.failure('[Loop]', 'https://x.test', error);
        }));

        expect(lines.warn).toHaveLength(2);
    });

    test('returns the classification for the caller', () => {
        const result = withLevel('error', () => logger.failure('[Loop]', 'https://x.test', new HttpError(429, 'Too Many')));
        expect(result.kind).toBe('RATE_LIMITED');
    });
});
