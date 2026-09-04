import { CLOUD_ENABLED } from '../../config/features.js';

const withEnv = (value, fn) => {
    const previous = process.env.CLOUD_ENABLED;
    if (value === undefined) delete process.env.CLOUD_ENABLED;
    else process.env.CLOUD_ENABLED = value;

    try {
        return fn();
    } finally {
        if (previous === undefined) delete process.env.CLOUD_ENABLED;
        else process.env.CLOUD_ENABLED = previous;
    }
};

describe('CLOUD_ENABLED', () => {
    test('is off unless it is switched on', () => {
        // The default has to be off: Cloud news still drops an incident the moment it is
        // resolved, so a thread would sit on "we are monitoring" forever.
        expect(withEnv(undefined, CLOUD_ENABLED)).toBe(false);
        expect(withEnv('', CLOUD_ENABLED)).toBe(false);
    });

    test.each(['1', 'true', 'TRUE', 'yes', 'on'])('%s turns it on', (value) => {
        expect(withEnv(value, CLOUD_ENABLED)).toBe(true);
    });

    test.each(['0', 'false', 'no', 'off', 'nonsense'])('%s leaves it off', (value) => {
        expect(withEnv(value, CLOUD_ENABLED)).toBe(false);
    });

    test('is read at call time, not at import time', () => {
        // A flag frozen at import cannot be flipped by a restart with a changed env, which is
        // the entire point of having one.
        expect(withEnv('true', CLOUD_ENABLED)).toBe(true);
        expect(withEnv('false', CLOUD_ENABLED)).toBe(false);
    });
});
