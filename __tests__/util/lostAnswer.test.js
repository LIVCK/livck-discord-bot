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
    let id = 0;
    return {
        created,
        Message: {
            create: async (row) => { const stored = { id: (id += 1), ...row }; created.push(stored); return stored; },
            update: async (values, { where }) => { Object.assign(created.find((r) => r.id === where.id), values); return [1]; },
        },
    };
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

    // The backoff's retry, on a later cycle: the row is still pending, so it posts again — with
    // the nonce the row was written with.
    expect(models.created).toHaveLength(1);
    expect(models.created[0].messageId).toMatch(/^pending:/);
    await expect(syncMessage({ channel: resolved, record: models.created[0], payload, models, create })).resolves.toBe('created');

    expect(fake.messagesIn(CHANNEL)).toHaveLength(1);
    // And the row points at the message that is actually there.
    expect(models.created.map((row) => row.messageId)).toEqual(fake.messagesIn(CHANNEL).map((m) => m.id));
});

test('a process killed between the post and the row: the next one posts nothing new', async () => {
    // SIGKILL after Discord made the message and before the row existed. Found by the simulation
    // in __tests__/sim mid-burst: the next process, with a fresh nonce, posted it again.
    const resolved = await client.channels.fetch(CHANNEL);
    const create = { subscriptionId: 1, category: 'ALERT', serviceId: 'upd-3' };
    // The process dies after the POST and before the row is confirmed: the pending row it wrote
    // first is what the next process finds.
    const pendingRows = [];
    const dying = { Message: { create: async (row) => { pendingRows.push({ id: 99, ...row }); return pendingRows.at(-1); }, update: () => new Promise(() => {}) } };

    syncMessage({ channel: resolved, record: null, payload, models: dying, create });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fake.messagesIn(CHANNEL)).toHaveLength(1);

    clearPendingNonces(); // the process is gone, and with it everything it remembered
    const models = rows();
    const [pending] = pendingRows;
    expect(pending.messageId).toMatch(/^pending:/);
    models.created.push(pending);
    await expect(syncMessage({ channel: resolved, record: pending, payload, models, create })).resolves.toBe('created');

    expect(fake.messagesIn(CHANNEL)).toHaveLength(1);
    expect(pending.messageId).toBe(fake.messagesIn(CHANNEL)[0].id);
});

test('a message an admin deleted is posted again with a nonce of its own', async () => {
    // The derived nonce would ask Discord for the message it already made — the deleted one.
    const resolved = await client.channels.fetch(CHANNEL);
    const create = { subscriptionId: 1, category: 'NEWS', serviceId: 'inc-1' };
    const nonces = [];
    const send = (body, channel) => { nonces.push(body.nonce); return channel.send(body); };
    const created = [];
    const models = {
        Message: {
            create: async (row) => { const r = { id: created.length + 1, ...row, destroy: async () => {} }; created.push(r); return r; },
            update: async (values, { where }) => { Object.assign(created.find((r) => r.id === where.id), values); return [1]; },
        },
    };

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
