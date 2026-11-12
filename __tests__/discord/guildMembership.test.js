/**
 * discord/guildMembership.js against a real discord.js Client, with Discord's own gateway
 * packets fed through the library's own handler — so what is tested is how discord.js tells a
 * kick from an outage, not how this test imagines it does.
 */

import { jest } from '@jest/globals';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { watchGuildMembership } from '../../discord/guildMembership.js';
import { deliver, resetDelivery } from '../../util/delivery.js';

let client;
let destroyed;
let rows;

const models = () => ({
    Subscription: {
        destroy: jest.fn(async ({ where }) => {
            const before = rows.length;
            rows = rows.filter((row) => row.guildId !== where.guildId);
            destroyed.push(where.guildId);
            return before - rows.length;
        }),
        findAll: async () => rows,
    },
});

const join = (id) => client.guilds._add({ id, name: id, channels: [], roles: [], members: [] });
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
    resetDelivery();
    destroyed = [];
    rows = [{ guildId: 'a' }, { guildId: 'a' }, { guildId: 'b' }];
    client = new Client({ intents: [GatewayIntentBits.Guilds] });
});

afterEach(async () => {
    resetDelivery();
    await client.destroy();
});

test('a kick deletes the guild\'s subscriptions, and only that guild\'s', async () => {
    watchGuildMembership(client, models());
    join('a');
    join('b');

    // GUILD_DELETE without `unavailable`: removed, left, or the guild was deleted.
    client.actions.GuildDelete.handle({ id: 'a' });
    await flush();

    expect(destroyed).toEqual(['a']);
    expect(rows).toEqual([{ guildId: 'b' }]);
});

test('an outage deletes nothing', async () => {
    watchGuildMembership(client, models());
    join('a');

    // The same packet with `unavailable: true` is Discord having trouble, not a kick.
    client.actions.GuildDelete.handle({ id: 'a', unavailable: true });
    await flush();

    expect(destroyed).toEqual([]);
});

test('a guild missing from the list at login is skipped, not deleted', async () => {
    watchGuildMembership(client, models());
    join('b');
    client.isReady = () => true;

    client.emit(Events.ClientReady, client);
    await flush();

    let asked = false;
    await expect(deliver({ id: 1, guildId: 'a' }, 'status', async () => { asked = true; })).resolves.toEqual({ status: 'absent' });
    expect(asked).toBe(false);
    await expect(deliver({ id: 2, guildId: 'b' }, 'status', async () => 'ok')).resolves.toMatchObject({ status: 'done' });
    expect(destroyed).toEqual([]);

    // Invited back: GUILD_CREATE puts it in the cache, and it is delivered again.
    join('a');
    await expect(deliver({ id: 1, guildId: 'a' }, 'status', async () => 'ok')).resolves.toMatchObject({ status: 'done' });
});

test('before the gateway has listed the guilds, nothing is skipped', async () => {
    // Right after login the cache is still filling; skipping then would drop a whole cycle.
    watchGuildMembership(client, models());

    await expect(deliver({ id: 1, guildId: 'a' }, 'status', async () => 'ok')).resolves.toMatchObject({ status: 'done' });
});

test('a database error on a kick is logged, not thrown', async () => {
    const failing = models();
    failing.Subscription.destroy = async () => { throw new Error('db down'); };
    watchGuildMembership(client, failing);
    join('a');

    client.actions.GuildDelete.handle({ id: 'a' });
    await flush();

    // Not deleted, but no longer in the cache, so skipped from here on.
    client.isReady = () => true;
    await expect(deliver({ id: 1, guildId: 'a' }, 'status', async () => 'ok')).resolves.toEqual({ status: 'absent' });
});
