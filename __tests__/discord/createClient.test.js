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
const { deliver, resetDelivery } = await import('../../util/delivery.js');
const { startFakeDiscord } = await import('../fixtures/fakeDiscord.js');

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

test('a changed channel or role in a guild lets its channels try again at once', async () => {
    // A channel the bot cannot see sits out up to six hours. The admin who fixes the
    // permission should not wait for that, nor need to know to run /livck afterwards.
    client = createClient();
    resetDelivery();
    const hidden = () => Object.assign(new Error('Missing Access'), { code: 50001 });
    const mine = { id: 1, guildId: 'g1', channelId: 'c1' };
    const other = { id: 2, guildId: 'g2', channelId: 'c2' };

    // Raw packets: discord.js emits channelUpdate only for a channel it has cached, and a channel
    // the bot could not see is the one it has not.
    for (const t of ['CHANNEL_UPDATE', 'CHANNEL_CREATE', 'GUILD_ROLE_UPDATE', 'GUILD_ROLE_CREATE', 'GUILD_MEMBER_UPDATE']) {
        const event = 'raw';
        const args = [{ op: 0, t, d: { id: 'x', guild_id: 'g1' } }, 0];
        await deliver(mine, 'status', async () => { throw hidden(); }).catch(() => {});
        await deliver(other, 'status', async () => { throw hidden(); }).catch(() => {});

        client.emit(event, ...args);

        await expect(deliver(mine, 'status', async () => {})).resolves.toMatchObject({ status: 'done' });
        await expect(deliver(other, 'status', async () => {})).resolves.toMatchObject({ status: 'backoff' });
    }
    resetDelivery();
});

test('a refused request reaches the bot as Discord\'s error, with its code', async () => {
    // The listeners this client carries must not touch the response body: @discordjs/rest shares
    // it with the request in progress, and a listener that read it turned every 403 into an
    // undici AssertionError with no code. A hidden channel (50001) then went unrecognised.
    // Found by the simulation; this is the real client against a real HTTP answer.
    const fake = await startFakeDiscord();
    try {
        client = createClient();
        client.rest.options.api = fake.api;
        client.rest.setToken('fake-token');
        fake.script('1500000000000000001', 'forbidden');

        const error = await client.rest.post('/channels/1500000000000000001/messages', { body: { content: 'x' } })
            .catch((e) => e);

        expect(error.name).toMatch(/DiscordAPIError/);
        expect(error.code).toBe(50013);
        expect(error.status).toBe(403);
    } finally {
        await fake.close();
    }
});
