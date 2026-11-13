/**
 * A message that reached Discord although the answer did not.
 *
 * Found by running the real bot against the real API with the answers to its POSTs dropped on
 * the way back: @discordjs/rest timed out and sent the POST again, three times, and the
 * delivery's backoff sent it once more later — six copies of one incident in the channel, one
 * of them recorded. The real discord.js client here, against a fake that does the same.
 */

import { Client, GatewayIntentBits } from 'discord.js';
import { startFakeDiscord } from '../fixtures/fakeDiscord.js';
import { syncMessage, clearPendingNonces } from '../../util/messageSync.js';

const CHANNEL = '1500000000000000001';
const payload = { embeds: [{ title: 'Störung: API', description: 'Wir schauen' }], components: [] };

let fake;
let client;

beforeEach(async () => {
    clearPendingNonces();
    fake = await startFakeDiscord();
    // A short client timeout, so its retries happen within the test rather than after 15s each.
    client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { api: fake.api, timeout: 200, retries: 3 } });
    client.rest.setToken('fake-token');
    // The gateway fills this in in production; without a guild discord.js builds no text channel.
    client.guilds._add({ id: fake.guildId, name: 'Fake Guild', channels: [], roles: [], members: [] });
});

afterEach(async () => {
    await client.destroy();
    await fake.close();
});

const rows = () => {
    const created = [];
    return { created, Message: { create: async (row) => { created.push(row); return row; } } };
};

test('the library\'s own retries do not post it again', async () => {
    // discord.js retries a 5xx, and it retries a timeout — but not under Jest, where the abort
    // is a DOMException from another realm and fails its `instanceof Error`. A 502 after the
    // work was done is the same situation from the client's side, and does run here.
    const resolved = await client.channels.fetch(CHANNEL);
    const models = rows();
    fake.script(CHANNEL, 'badGateway');

    await expect(syncMessage({ channel: resolved, record: null, payload, models, create: { subscriptionId: 1, category: 'NEWS', serviceId: 'inc-1' } }))
        .rejects.toBeTruthy();

    // Every attempt reached the channel; one message came of it.
    expect(fake.requests(CHANNEL, { method: 'POST' }).length).toBeGreaterThan(1);
    expect(fake.messagesIn(CHANNEL)).toHaveLength(1);
});

test('nor does the next attempt, once the channel answers again', async () => {
    const resolved = await client.channels.fetch(CHANNEL);
    const models = rows();
    const create = { subscriptionId: 1, category: 'NEWS', serviceId: 'inc-1' };

    fake.script(CHANNEL, 'loseAnswer');
    await syncMessage({ channel: resolved, record: null, payload, models, create }).catch(() => {});
    fake.script(CHANNEL, 'ok');

    // The backoff's retry, on a later cycle: still no row, so it posts again.
    await expect(syncMessage({ channel: resolved, record: null, payload, models, create })).resolves.toBe('created');

    expect(fake.messagesIn(CHANNEL)).toHaveLength(1);
    // And the row points at the message that is actually there.
    expect(models.created.map((row) => row.messageId)).toEqual(fake.messagesIn(CHANNEL).map((m) => m.id));
});

test('a process killed between the post and the row: the next one posts nothing new', async () => {
    // SIGKILL after Discord made the message and before the row existed. Found by the simulation
    // in __tests__/sim mid-burst: the next process, with a fresh nonce, posted it again.
    const resolved = await client.channels.fetch(CHANNEL);
    const create = { subscriptionId: 1, category: 'ALERT', serviceId: 'upd-3' };
    const dying = { Message: { create: () => new Promise(() => {}) } };

    syncMessage({ channel: resolved, record: null, payload, models: dying, create });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fake.messagesIn(CHANNEL)).toHaveLength(1);

    clearPendingNonces(); // the process is gone, and with it everything it remembered
    const models = rows();
    await expect(syncMessage({ channel: resolved, record: null, payload, models, create })).resolves.toBe('created');

    expect(fake.messagesIn(CHANNEL)).toHaveLength(1);
    expect(models.created.map((row) => row.messageId)).toEqual(fake.messagesIn(CHANNEL).map((m) => m.id));
});

test('a message an admin deleted is posted again with a nonce of its own', async () => {
    // The derived nonce would ask Discord for the message it already made — the deleted one.
    const resolved = await client.channels.fetch(CHANNEL);
    const create = { subscriptionId: 1, category: 'NEWS', serviceId: 'inc-1' };
    const nonces = [];
    const send = (body, channel) => { nonces.push(body.nonce); return channel.send(body); };
    const created = [];
    const models = { Message: { create: async (row) => { const r = { ...row, destroy: async () => {} }; created.push(r); return r; } } };

    await syncMessage({ channel: resolved, record: null, payload, models, create, send });
    const first = fake.messagesIn(CHANNEL)[0].id;
    fake.messages.delete(first);

    // The next change finds it gone…
    const changed = { ...payload, embeds: [{ title: 'Störung: API', description: 'Behoben' }] };
    await expect(syncMessage({ channel: resolved, record: { ...created[0], contentHash: 'old' }, payload: changed, models, create, send }))
        .resolves.toBe('recreate');
    // …and the cycle after posts it anew.
    await syncMessage({ channel: resolved, record: null, payload: changed, models, create, send });

    expect(nonces).toHaveLength(2);
    expect(nonces[1]).not.toBe(nonces[0]);
    expect(fake.messagesIn(CHANNEL)).toHaveLength(1);
    expect(fake.messagesIn(CHANNEL)[0].id).not.toBe(first);
});

test('two different messages for the same channel are not mistaken for one', async () => {
    const resolved = await client.channels.fetch(CHANNEL);
    const models = rows();

    await syncMessage({ channel: resolved, record: null, payload, models, create: { subscriptionId: 1, category: 'NEWS', serviceId: 'inc-1' } });
    await syncMessage({ channel: resolved, record: null, payload, models, create: { subscriptionId: 1, category: 'ALERT', serviceId: 'upd-1' } });

    expect(fake.messagesIn(CHANNEL)).toHaveLength(2);
});
