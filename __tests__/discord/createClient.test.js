/**
 * The client the bot actually runs with.
 *
 * discord/restPolicy.js is tested on its own and through the real discord.js client in the loop
 * tests — but those build their own client. Whether discord/bot.js hands the policy to the one
 * that goes to production was tested by nothing, and without it every 429 is retried for ever
 * again: the production freeze all of this began with.
 *
 * A real discord.js Client, constructed and never logged in.
 */

import { jest } from '@jest/globals';

// The router reaches the models, which open a database connection at import time.
jest.unstable_mockModule('../../models/index.js', () => ({ default: {} }));
jest.unstable_mockModule('../../database/redis.js', () => ({
    default: { set: async () => 'OK', get: async () => null, del: async () => 1, isOpen: false },
}));

const { createClient } = await import('../../discord/bot.js');

let client;
afterEach(async () => {
    client?.restPolicy?.stop();
    await client?.destroy();
    client = null;
});

test('a 429 is decided by the policy, not retried for ever', () => {
    client = createClient();

    expect(typeof client.rest.options.rejectOnRateLimit).toBe('function');
    // The policy's own decision, not just any function: a delivery to a channel whose bucket
    // would make it wait past the limit is refused.
    expect(client.rest.options.rejectOnRateLimit({
        url: 'https://discord.com/api/v10/channels/1/messages', method: 'POST', timeToReset: 10 * 60_000,
    })).toBe(true);
});

test('the warning before a Cloudflare ban is switched on and listened to', () => {
    client = createClient();

    // 0, the default, disables the warning entirely.
    expect(client.rest.options.invalidRequestWarningInterval).toBeGreaterThan(0);
    expect(client.rest.listenerCount('invalidRequestWarning')).toBe(1);
});

test('refused requests and rate limit waits reach the minute summary', () => {
    client = createClient();

    expect(client.rest.listenerCount('response')).toBe(1);
    expect(client.rest.listenerCount('rateLimited')).toBe(1);
});
