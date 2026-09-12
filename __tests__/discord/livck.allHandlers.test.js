/**
 * Every component and modal handler `/livck` has, driven once.
 *
 * `discord/commands/livck.js` is 2400 lines and was at 21% — the largest gap in the project by
 * a wide margin, and the part a customer touches directly. Five defects were found in it by
 * review alone; this is what stops the sixth arriving in a channel.
 *
 * The list of ids is not from memory. It is every `interaction.customId` the file branches on,
 * enumerated from the source, so a handler added later without a test here shows up as one the
 * roster does not mention.
 *
 * The fake interaction enforces discord.js's real reply state machine — reply and defer throw
 * once the interaction has been answered — because getting that wrong is exactly how the
 * process used to die.
 */

import { jest } from '@jest/globals';

jest.unstable_mockModule('../../database/redis.js', () => ({
    default: { get: async () => null, set: async () => {}, del: async () => {} },
}));
jest.unstable_mockModule('../../handlers/handleStatuspage.js', () => ({
    handleStatusPage: async () => {}, default: {},
}));
jest.unstable_mockModule('../../api/detect.js', () => ({
    detectSource: async () => 'SELF_HOSTED', classifyHeaders: () => null, default: {},
}));
jest.unstable_mockModule('../../api/livckCloud.js', () => ({
    default: class { async fetchStatus() { return {}; } },
}));

const buildCommand = (await import('../../discord/commands/livck.js')).default;

/** Every id the file branches on. Kept in step with the source by the roster test below. */
const COMPONENT_IDS = [
    'add_link_1', 'add_role_1', 'back_to_edit_1', 'delete_link_7', 'delete_sub_1',
    'edit_api_token_1', 'edit_done', 'edit_link_7', 'manage_links_1', 'manage_roles_1',
    'move_link_down_7', 'move_link_up_7', 'remove_role_1', 'role_event_type_1',
    'select_link_1', 'unsub_1', 'update_layout_1', 'update_locale_1',
];

const MODAL_IDS = [
    'add_link_submit_1', 'edit_api_token_submit_1', 'edit_link_submit_7', 'subscribe_complete_modal',
];

const db = {};

const statuspage = () => ({ id: 10, name: 'Beispiel', url: 'https://status.example.com' });

const subscriptionRow = () => ({
    id: 1, guildId: 'guild-1', channelId: 'chan-1', statuspageId: 10,
    layout: 'DETAILED', locale: 'de', apiToken: null,
    eventTypes: { STATUS: true, NEWS: true },
    Statuspage: statuspage(),
    update: async function (fields) { Object.assign(this, fields); },
    destroy: async () => {},
});

const linkRow = () => ({
    id: 7, subscriptionId: 1, label: 'Doku', url: 'https://docs.example.com', emoji: null, position: 0,
    Subscription: subscriptionRow(),
    update: async function (fields) { Object.assign(this, fields); },
    destroy: async () => { db.links = db.links.filter((l) => l.id !== 7); },
});

const models = {
    Subscription: {
        findOne: async ({ where }) => db.subscriptions.find(
            (s) => String(s.id) === String(where.id) && s.guildId === where.guildId) ?? null,
        findAll: async ({ where }) => db.subscriptions.filter((s) => s.guildId === where.guildId),
        create: async (row) => ({ ...row, id: 99, Statuspage: statuspage() }),
        update: async () => [1],
        destroy: async () => 1,
        count: async () => db.subscriptions.length,
    },
    Statuspage: {
        findOne: async () => db.statuspage,
        create: async (row) => ({ ...row, id: 10 }),
    },
    CustomLink: {
        findOne: async ({ where }) => db.links.find((l) => String(l.id) === String(where.id)) ?? null,
        findAll: async ({ where }) => db.links.filter(
            (l) => String(l.subscriptionId) === String(where?.subscriptionId ?? 1)),
        create: async (row) => { const r = { ...row, id: 8 }; db.links.push(r); return r; },
        count: async () => db.links.length,
        destroy: async () => 1,
    },
    RoleMention: {
        findAll: async () => db.roles,
        // With an id, because the database always assigns one — and the remove-select builds
        // its option values from it. Returning a row without one produced `value: "undefined"`,
        // which is a defect in the double, not in the handler.
        findOrCreate: async ({ where }) => {
            const row = { id: db.roles.length + 1, ...where };
            db.roles.push(row);
            return [row, true];
        },
        count: async () => db.roles.length,
        destroy: async () => 1,
    },
    Message: { findOne: async () => null, findAll: async () => [], destroy: async () => 1 },
};

const command = buildCommand(models);

/** Enforces discord.js's real reply rules; anything else hides the bug that killed the bot. */
const makeInteraction = ({ customId, values = [], components = [], deferred = false }) => {
    const state = {
        locale: 'de',
        guildId: 'guild-1',
        user: { id: 'user-1' },
        customId,
        values,
        components,
        replied: false,
        deferred,
        replies: [],
        edits: [],
        followUps: [],
        modals: [],
        memberPermissions: { has: (flag) => flag === 'ManageGuild' },
        // What the handlers actually reach for, found in the source rather than guessed:
        // `interaction.client.rest.post` is how a Type 18 modal is opened (showModal cannot
        // carry Label components), and the role screens read role names from the guild cache.
        client: { rest: { post: async (route, body) => { state.modals.push(body); return {}; } } },
        guild: {
            channels: { cache: { get: () => ({ name: 'allgemein' }) } },
            roles: { cache: { get: (id) => ({ id, name: `Rolle ${id}` }) } },
        },
        fields: { getTextInputValue: (id) => ({ label: 'Doku', url: 'https://docs.example.com', emoji: '', api_token: '' }[id] ?? '') },
        reply: async (payload) => {
            if (state.replied || state.deferred) throw new Error('InteractionAlreadyReplied');
            state.replied = true; state.replies.push(payload);
        },
        deferUpdate: async () => {
            if (state.replied || state.deferred) throw new Error('InteractionAlreadyReplied');
            state.deferred = true;
        },
        deferReply: async () => {
            if (state.replied || state.deferred) throw new Error('InteractionAlreadyReplied');
            state.deferred = true;
        },
        editReply: async (payload) => { state.edits.push(payload); },
        followUp: async (payload) => { state.followUps.push(payload); },
        update: async (payload) => { state.edits.push(payload); },
        showModal: async (payload) => { state.modals.push(payload); },
    };
    return state;
};

/** Anything the user would be shown. */
const shown = (interaction) => JSON.stringify([
    ...interaction.replies, ...interaction.edits, ...interaction.followUps, ...interaction.modals,
]);

beforeEach(() => {
    db.statuspage = statuspage();
    db.subscriptions = [subscriptionRow()];
    db.links = [linkRow()];
    db.roles = [{ id: 1, subscriptionId: 1, roleId: 'role-1', eventType: 'ALL' }];
});

describe('the roster', () => {
    test('names every id the source branches on', async () => {
        // The point of this test: a handler added without a test here fails it, rather than
        // quietly going unexercised in a 2400-line file.
        const fs = await import('fs');
        const source = fs.readFileSync('discord/commands/livck.js', 'utf8');

        const branched = new Set([
            ...[...source.matchAll(/interaction\.customId === '([a-z_]+)'/g)].map((m) => m[1]),
            ...[...source.matchAll(/interaction\.customId\.startsWith\('([a-z_]+_)'\)/g)].map((m) => m[1]),
        ]);

        const roster = [...COMPONENT_IDS, ...MODAL_IDS];
        const untested = [...branched].filter(
            (branch) => !roster.some((id) => id === branch || id.startsWith(branch)));

        expect(untested).toEqual([]);
    });
});

describe('every component handler', () => {
    test.each(COMPONENT_IDS)('%s answers without throwing', async (customId) => {
        const values = customId.startsWith('select_link_') ? ['link_7']
            : customId.startsWith('update_locale_') ? ['en']
            : customId.startsWith('update_layout_') ? ['COMPACT']
            : customId.startsWith('role_event_type_') ? ['NEWS']
            : customId.startsWith('remove_role_') ? ['role-1']
            : customId.startsWith('add_role_') ? ['role-2']
            : [];

        const interaction = makeInteraction({ customId, values });

        await expect(command.handleComponentInteraction(interaction, {})).resolves.toBeUndefined();

        // Every path must say SOMETHING; a silent handler is "This interaction failed".
        const answered = interaction.replies.length + interaction.edits.length
            + interaction.followUps.length + interaction.modals.length;
        expect(answered).toBeGreaterThan(0);
    });

    test.each(COMPONENT_IDS)('%s never shows a raw translation key', async (customId) => {
        const interaction = makeInteraction({ customId, values: ['link_7'] });
        await command.handleComponentInteraction(interaction, {});

        expect(shown(interaction)).not.toMatch(/\b(commands|messages)\.livck\.[a-z_.]+/);
        expect(shown(interaction)).not.toMatch(/\bundefined\b|\[object Object\]/);
    });

    test.each(COMPONENT_IDS)('%s survives the subscription being gone', async (customId) => {
        // Two panels open, one deletes. Every handler has to cope, not crash.
        db.subscriptions = [];
        db.links = [];

        const interaction = makeInteraction({ customId, values: ['link_7'] });

        await expect(command.handleComponentInteraction(interaction, {})).resolves.toBeUndefined();
    });
});

describe('every modal handler', () => {
    test.each(MODAL_IDS)('%s answers without throwing', async (customId) => {
        const components = customId === 'subscribe_complete_modal'
            ? [
                { type: 18, component: { type: 4, customId: 'url', value: 'https://status.example.com' } },
                { type: 18, component: { type: 8, customId: 'channel', values: ['chan-1'] } },
                { type: 18, component: { type: 3, customId: 'events', values: ['all'] } },
                { type: 18, component: { type: 3, customId: 'locale', values: ['de'] } },
                { type: 18, component: { type: 3, customId: 'layout', values: ['DETAILED'] } },
            ]
            : [];

        const interaction = makeInteraction({ customId, components });

        await expect(command.handleModalSubmit(interaction, {})).resolves.toBeUndefined();
    });

    test('the subscribe modal refuses an incomplete submission rather than creating half a row', async () => {
        const interaction = makeInteraction({
            customId: 'subscribe_complete_modal',
            components: [{ type: 18, component: { type: 4, customId: 'url', value: 'https://status.example.com' } }],
        });

        await command.handleModalSubmit(interaction, {});

        expect(shown(interaction)).toMatch(/fehl|error|Fehler/i);
    });
});

describe('every subcommand', () => {
    const slash = (name, options = {}) => {
        const interaction = makeInteraction({ customId: `slash-${name}` });
        interaction.options = {
            getSubcommand: () => name,
            getString: (key) => options[key] ?? null,
            getChannel: (key) => options[key] ?? null,
            getFocused: () => ({ name: 'subscription', value: '' }),
        };
        interaction.member = { permissions: { has: () => true } };
        interaction.respond = async (choices) => { interaction.replies.push({ choices }); };
        return interaction;
    };

    test.each([
        ['list', {}],
        ['subscribe', {}],
        ['unsubscribe', { url: 'https://status.example.com' }],
        ['resume', { url: 'https://status.example.com' }],
    ])('/livck %s answers', async (name, options) => {
        const interaction = slash(name, options);

        await expect(command.execute(interaction, {})).resolves.toBeUndefined();

        const answered = interaction.replies.length + interaction.edits.length
            + interaction.followUps.length + interaction.modals.length;
        expect(answered).toBeGreaterThan(0);
    });

    test('autocomplete answers even with nothing to suggest', async () => {
        db.subscriptions = [];
        const interaction = slash('edit');

        await expect(command.autocomplete(interaction, {})).resolves.toBeUndefined();
        expect(interaction.replies).toHaveLength(1);
    });
});
