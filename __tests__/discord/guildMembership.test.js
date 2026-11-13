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

/**
 * A gateway packet, delivered the way discord.js's WebSocketManager does: `raw` first, then the
 * library's own handler.
 */
const gateway = (t, d) => {
    client.emit(Events.Raw, { op: 0, t, d }, 0);
    if (t === 'GUILD_CREATE') client.guilds._add({ id: d.id, name: d.id, channels: [], roles: [], members: [] });
    if (t === 'GUILD_DELETE') client.actions.GuildDelete.handle(d);
};
const ready = (...ids) => gateway('READY', { guilds: ids.map((id) => ({ id, unavailable: true })) });
const flush = () => new Promise((resolve) => setImmediate(resolve));
const sub = (id, guildId) => ({ id, guildId });

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
    ready('a', 'b');
    gateway('GUILD_CREATE', { id: 'a' });
    gateway('GUILD_CREATE', { id: 'b' });

    // GUILD_DELETE without `unavailable`: removed, left, or the guild was deleted.
    gateway('GUILD_DELETE', { id: 'a' });
    await flush();

    expect(destroyed).toEqual(['a']);
    expect(rows).toEqual([{ guildId: 'b' }]);
    await expect(deliver(sub(1, 'a'), 'status', async () => 'ok')).resolves.toEqual({ status: 'absent' });
});

test('an outage deletes nothing and skips nothing', async () => {
    watchGuildMembership(client, models());
    ready('a');
    gateway('GUILD_CREATE', { id: 'a' });

    gateway('GUILD_DELETE', { id: 'a', unavailable: true });
    await flush();

    expect(destroyed).toEqual([]);
    await expect(deliver(sub(1, 'a'), 'status', async () => 'ok')).resolves.toMatchObject({ status: 'done' });
});

test('a guild missing from the list at login is skipped, not deleted, and back when invited', async () => {
    watchGuildMembership(client, models());
    ready('b');
    await flush();

    let asked = false;
    await expect(deliver(sub(1, 'a'), 'status', async () => { asked = true; })).resolves.toEqual({ status: 'absent' });
    expect(asked).toBe(false);
    await expect(deliver(sub(2, 'b'), 'status', async () => 'ok')).resolves.toMatchObject({ status: 'done' });
    expect(destroyed).toEqual([]);

    gateway('GUILD_CREATE', { id: 'a' });
    await expect(deliver(sub(1, 'a'), 'status', async () => 'ok')).resolves.toMatchObject({ status: 'done' });
});

test('kicked while the gateway was down: the READY after it reconnects is believed, not the cache', async () => {
    // discord.js keeps a guild in its cache that a later READY no longer lists. The simulation
    // found the bot asking a guild for good after a kick during a gateway drop.
    watchGuildMembership(client, models());
    ready('a', 'b');
    gateway('GUILD_CREATE', { id: 'a' });
    gateway('GUILD_CREATE', { id: 'b' });

    ready('b'); // reconnected; no GUILD_DELETE was ever received
    expect(client.guilds.cache.has('a')).toBe(true);
    await expect(deliver(sub(1, 'a'), 'status', async () => 'ok')).resolves.toEqual({ status: 'absent' });
    expect(destroyed).toEqual([]);
});

test('before the gateway has listed the guilds, nothing is skipped', async () => {
    // Right after login the list is not known yet; skipping then would drop a whole cycle.
    watchGuildMembership(client, models());

    await expect(deliver(sub(1, 'a'), 'status', async () => 'ok')).resolves.toMatchObject({ status: 'done' });
});

test('a database error on a kick is logged, not thrown', async () => {
    const failing = models();
    failing.Subscription.destroy = async () => { throw new Error('db down'); };
    watchGuildMembership(client, failing);
    ready('a');
    gateway('GUILD_CREATE', { id: 'a' });

    gateway('GUILD_DELETE', { id: 'a' });
    await flush();

    // Not deleted, but no longer in the list, so skipped from here on.
    await expect(deliver(sub(1, 'a'), 'status', async () => 'ok')).resolves.toEqual({ status: 'absent' });
});
