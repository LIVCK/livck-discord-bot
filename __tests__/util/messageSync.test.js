import { EmbedBuilder } from 'discord.js';
import { hashPayload, syncMessage } from '../../util/messageSync.js';

const embed = (title, description) => new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setTimestamp(new Date());

describe('hashPayload', () => {
    test('identical content hashes alike across renders', () => {
        expect(hashPayload({ embeds: [embed('Status', 'ok')] }))
            .toBe(hashPayload({ embeds: [embed('Status', 'ok')] }));
    });

    test('the render timestamp does not affect the hash', () => {
        // Every layout calls setTimestamp(new Date()); if that fed the hash, no two renders
        // would ever match and the dirty check would be dead code.
        const early = new EmbedBuilder().setTitle('S').setTimestamp(new Date('2020-01-01'));
        const late = new EmbedBuilder().setTitle('S').setTimestamp(new Date('2030-01-01'));

        expect(hashPayload({ embeds: [early] })).toBe(hashPayload({ embeds: [late] }));
    });

    test('a changed status changes the hash', () => {
        expect(hashPayload({ embeds: [embed('Status', 'ok')] }))
            .not.toBe(hashPayload({ embeds: [embed('Status', 'down')] }));
    });

    test('components are part of the hash', () => {
        const base = { embeds: [embed('S', 'x')] };
        const withButton = { embeds: [embed('S', 'x')], components: [{ toJSON: () => ({ type: 1 }) }] };

        expect(hashPayload(base)).not.toBe(hashPayload(withButton));
    });

    test('message content is part of the hash', () => {
        expect(hashPayload({ content: '<@&1>' })).not.toBe(hashPayload({ content: '<@&2>' }));
    });

    test('an empty payload is hashable', () => {
        expect(typeof hashPayload({})).toBe('string');
        expect(hashPayload()).toBe(hashPayload({}));
    });
});

/** Minimal stand-ins — the point is which Discord calls happen, not what they return. */
const makeChannel = () => {
    const calls = { send: 0, edit: 0, fetch: 0, deleted: [] };
    return {
        calls,
        send: async () => { calls.send += 1; return { id: 'new-message-id' }; },
        messages: {
            edit: async () => { calls.edit += 1; return { id: 'existing' }; },
            fetch: async () => { calls.fetch += 1; return { id: 'existing' }; },
            delete: async (id) => { calls.deleted.push(id); },
        },
    };
};

const makeRecord = (hash, updatedAt = new Date()) => {
    const record = {
        messageId: 'existing',
        contentHash: hash,
        updatedAt,
        destroyed: false,
        update: async (fields) => { Object.assign(record, fields); },
        destroy: async () => { record.destroyed = true; },
    };
    return record;
};

const makeModels = () => {
    const created = [];
    const updated = [];
    return {
        created,
        updated,
        Message: {
            create: async (row) => { created.push(row); return row; },
            // A QUERY-level update, which is what the production code has to use: an
            // instance-level `record.update()` with an unchanged value issues no SQL at all,
            // so `updatedAt` never moves and the heartbeat re-fires every single cycle.
            update: async (values, options) => { updated.push({ values, options }); return [1]; },
        },
    };
};

describe('syncMessage', () => {
    const payload = { embeds: [embed('Status', 'ok')] };

    test('creates a message when none is tracked', async () => {
        const channel = makeChannel();
        const models = makeModels();

        const result = await syncMessage({
            channel, record: null, payload, models, create: { subscriptionId: 1, category: 'STATUS' },
        });

        expect(result).toBe('created');
        expect(channel.calls.send).toBe(1);
        expect(models.created[0].messageId).toBe('new-message-id');
        expect(models.created[0].contentHash).toBe(hashPayload(payload));
    });

    test('skips the edit when nothing changed', async () => {
        const channel = makeChannel();
        const record = makeRecord(hashPayload(payload));

        const result = await syncMessage({
            channel, record, payload, models: makeModels(), create: {},
        });

        expect(result).toBe('skipped');
        expect(channel.calls.edit).toBe(0);
    });

    test('edits when the content changed', async () => {
        const channel = makeChannel();
        const record = makeRecord('a-stale-hash');

        const result = await syncMessage({
            channel, record, payload, models: makeModels(), create: {},
        });

        expect(result).toBe('updated');
        expect(channel.calls.edit).toBe(1);
        expect(record.contentHash).toBe(hashPayload(payload));
    });

    test('never fetches the message before editing', async () => {
        // The old handlers did fetch() then edit() — two REST calls per subscription per
        // cycle against a 50 req/s budget. One PATCH is enough.
        const channel = makeChannel();

        await syncMessage({
            channel, record: makeRecord('stale'), payload, models: makeModels(), create: {},
        });

        expect(channel.calls.fetch).toBe(0);
        expect(channel.calls.edit).toBe(1);
    });

    test('refreshes an unchanged message once it is stale, when heartbeat is on', async () => {
        const channel = makeChannel();
        const old = new Date(Date.now() - 60 * 60 * 1000);
        const record = makeRecord(hashPayload(payload), old);

        const result = await syncMessage({
            channel, record, payload, models: makeModels(), create: {}, heartbeat: true,
        });

        expect(result).toBe('updated');
    });

    test('writes the row down before it posts, and confirms it after', async () => {
        // A row written only after the POST left nothing behind when the process died in
        // between; see util/messageSync.js and __tests__/sim/faults.sim.test.js.
        const channel = makeChannel();
        const models = makeModels();
        const order = [];
        channel.send = async () => { order.push('send'); return { id: 'new-message-id' }; };
        const create = models.Message.create;
        models.Message.create = async (row) => { order.push(`create ${row.messageId.split(':')[0]}`); return create(row); };

        await syncMessage({ channel, record: null, payload, models, create: { subscriptionId: 1, category: 'STATUS' } });

        expect(order).toEqual(['create pending', 'send']);
        expect(models.updated.at(-1).values.messageId).toBe('new-message-id');
        expect(models.created[0].messageId).toBe('new-message-id');
    });

    test('a pending row is posted with the nonce it was written with', async () => {
        const channel = makeChannel();
        const nonces = [];
        // Discord hands back the message an earlier attempt made, with that attempt's content.
        channel.send = async (body) => { nonces.push(body.nonce); return { id: 'm1', content: '', embeds: [{ title: 'Status', description: 'damals' }], components: [] }; };
        const record = { id: 7, messageId: 'pending:the-nonce-0123456789xyz', contentHash: null };

        await expect(syncMessage({ channel, record, payload, models: makeModels(), create: { subscriptionId: 1, category: 'NEWS', serviceId: 'x' } }))
            .resolves.toBe('created');
        expect(nonces).toEqual(['the-nonce-0123456789xyz']);
        expect(record.messageId).toBe('m1');
        // Discord may have handed back the message an earlier attempt made, with that attempt's
        // content: unknown, so the next cycle edits it.
        expect(record.contentHash).toBeNull();
        const next = await syncMessage({ channel, record, payload, models: makeModels(), create: {} });
        expect(next).toBe('updated');
    });

    test('a pending row whose message already shows the payload is simply confirmed', async () => {
        const channel = makeChannel();
        channel.send = async (body) => ({ id: 'm1', content: '', embeds: body.embeds.map((e) => ({ ...e, type: 'rich' })), components: [] });
        const record = { id: 7, messageId: 'pending:abc', contentHash: null };

        await syncMessage({ channel, record, payload, models: makeModels(), create: {} });
        expect(record.contentHash).toBe(hashPayload(payload));
    });

    test('nothing is posted when the row cannot even be written down', async () => {
        const channel = makeChannel();
        const models = makeModels();
        models.Message.create = async () => { throw new Error('database went away'); };

        await expect(syncMessage({ channel, record: null, payload, models, create: {} })).rejects.toThrow('database went away');
        expect(channel.calls.send).toBe(0);
    });

    test('takes a new message back when its row cannot be confirmed', async () => {
        // Posted, then the database refused the confirmation: the row still says pending, and the
        // message is taken back so the next attempt does not leave two.
        const channel = makeChannel();
        const models = makeModels();
        models.Message.update = async () => { throw new Error('database went away'); };

        await expect(syncMessage({ channel, record: null, payload, models, create: {} }))
            .rejects.toThrow('database went away');

        expect(channel.calls.send).toBe(1);
        expect(channel.calls.deleted).toEqual(['new-message-id']);
    });

    test('still reports the database error when the take-back fails too', async () => {
        const channel = makeChannel();
        channel.messages.delete = async () => { throw new Error('discord unreachable'); };
        const models = makeModels();
        models.Message.update = async () => { throw new Error('database went away'); };

        await expect(syncMessage({ channel, record: null, payload, models, create: {} }))
            .rejects.toThrow('database went away');
    });

    test('a heartbeat refresh is written down, so the next cycle stays quiet', async () => {
        // The bug this guards came back once already: `record.update({contentHash})` with the
        // hash it already has is a no-op in Sequelize, updatedAt never moves, and every status
        // message is edited every fifteen seconds from then on. The record double here behaves
        // like Sequelize does — an instance update moves nothing that did not change.
        const channel = makeChannel();
        const models = makeModels();
        const record = makeRecord(hashPayload(payload), new Date(Date.now() - 60 * 60 * 1000));

        expect(await syncMessage({ channel, record, payload, models, create: {}, heartbeat: true })).toBe('updated');
        expect(await syncMessage({ channel, record, payload, models, create: {}, heartbeat: true })).toBe('skipped');

        expect(channel.calls.edit).toBe(1);
        // Forgotten before the edit, written after it.
        expect(models.updated.map((u) => u.values.contentHash)).toEqual([null, hashPayload(payload)]);
    });

    test('an edit whose answer never came is sent again, even when the content went back', async () => {
        // The page changed, the edit reached Discord, the answer did not; then the page changed
        // back. Comparing against the old hash said "unchanged", and the channel kept showing
        // the edit in between. Found by the simulation (__tests__/sim, chaos).
        const channel = makeChannel();
        const models = makeModels();
        const original = { embeds: [{ title: 'Status', description: 'grün' }] };
        const changed = { embeds: [{ title: 'Status', description: 'rot' }] };
        const record = makeRecord(hashPayload(original), new Date());

        channel.messages.edit = async () => { throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); };
        await expect(syncMessage({ channel, record, payload: changed, models, create: {} })).rejects.toThrow('aborted');

        let edits = 0;
        channel.messages.edit = async () => { edits += 1; return {}; };
        await expect(syncMessage({ channel, record, payload: original, models, create: {} })).resolves.toBe('updated');
        expect(edits).toBe(1);
    });

    test('a fresh unchanged message is left alone even with heartbeat on', async () => {
        const channel = makeChannel();
        const record = makeRecord(hashPayload(payload), new Date());

        const result = await syncMessage({
            channel, record, payload, models: makeModels(), create: {}, heartbeat: true,
        });

        expect(result).toBe('skipped');
        expect(channel.calls.edit).toBe(0);
    });

    test('a message deleted in Discord drops its row so the next cycle reposts', async () => {
        const channel = makeChannel();
        channel.messages.edit = async () => {
            const error = new Error('Unknown Message');
            error.code = 10008;
            throw error;
        };
        const record = makeRecord('stale');

        const result = await syncMessage({
            channel, record, payload, models: makeModels(), create: {},
        });

        expect(result).toBe('recreate');
        expect(record.destroyed).toBe(true);
    });

    test('any other Discord error propagates', async () => {
        const channel = makeChannel();
        channel.messages.edit = async () => {
            const error = new Error('Missing Access');
            error.code = 50001;
            throw error;
        };

        await expect(syncMessage({
            channel, record: makeRecord('stale'), payload, models: makeModels(), create: {},
        })).rejects.toMatchObject({ code: 50001 });
    });

    test('an unchanged message never resolves the channel at all', async () => {
        // The channel comes from discord.js's gateway cache in steady state, but that cache is
        // cold right after a restart — resolving it eagerly would mean one REST call per
        // subscription in the very first cycle.
        let resolved = 0;
        const record = makeRecord(hashPayload(payload));

        const result = await syncMessage({
            channel: () => { resolved += 1; return makeChannel(); },
            record,
            payload,
            models: makeModels(),
            create: {},
        });

        expect(result).toBe('skipped');
        expect(resolved).toBe(0);
    });

    test('a changed message resolves the channel once', async () => {
        let resolved = 0;
        const channel = makeChannel();

        await syncMessage({
            channel: () => { resolved += 1; return channel; },
            record: makeRecord('stale'),
            payload,
            models: makeModels(),
            create: {},
        });

        expect(resolved).toBe(1);
        expect(channel.calls.edit).toBe(1);
    });

    test('a channel that cannot be resolved is skipped, not crashed on', async () => {
        const result = await syncMessage({
            channel: () => null,
            record: null,
            payload,
            models: makeModels(),
            create: {},
        });

        expect(result).toBe('skipped');
    });

    test('a plain channel object still works', async () => {
        // Both call styles are in use; the thunk is an optimisation, not a new contract.
        const channel = makeChannel();

        await syncMessage({
            channel, record: makeRecord('stale'), payload, models: makeModels(), create: {},
        });

        expect(channel.calls.edit).toBe(1);
    });

    test('a custom send hook is used for new messages', async () => {
        let usedHook = false;
        const channel = makeChannel();

        await syncMessage({
            channel,
            record: null,
            payload,
            models: makeModels(),
            create: {},
            send: async (_payload, resolvedChannel) => {
                usedHook = true;
                expect(resolvedChannel).toBeDefined();
                return { id: 'reply-id' };
            },
        });

        expect(usedHook).toBe(true);
        expect(channel.calls.send).toBe(0);
    });
});
