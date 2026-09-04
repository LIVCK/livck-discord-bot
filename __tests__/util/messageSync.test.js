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
    const calls = { send: 0, edit: 0, fetch: 0 };
    return {
        calls,
        send: async () => { calls.send += 1; return { id: 'new-message-id' }; },
        messages: {
            edit: async () => { calls.edit += 1; return { id: 'existing' }; },
            fetch: async () => { calls.fetch += 1; return { id: 'existing' }; },
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
    return { created, Message: { create: async (row) => { created.push(row); return row; } } };
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

    test('a custom send hook is used for new messages', async () => {
        let usedHook = false;
        const channel = makeChannel();

        await syncMessage({
            channel,
            record: null,
            payload,
            models: makeModels(),
            create: {},
            send: async () => { usedHook = true; return { id: 'reply-id' }; },
        });

        expect(usedHook).toBe(true);
        expect(channel.calls.send).toBe(0);
    });
});
