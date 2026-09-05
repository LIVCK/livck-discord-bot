/**
 * Who is allowed to press the buttons.
 *
 * `default_member_permissions: '32'` (ManageGuild) is what Discord enforces on the slash
 * command — but it is a DEFAULT. A server admin can hand `/livck` to any role under Server
 * Settings → Integrations, which is why `execute()` re-checks the permission itself rather
 * than trusting the gate.
 *
 * The component and modal handlers did not re-check, and they are where the destructive
 * actions live: unsubscribe, delete a subscription, remove a role mention, replace the API
 * token of a private status page. This file pins that gap shut.
 */

import { jest } from '@jest/globals';

// The command module opens a Redis connection and pulls in the whole fetch stack at import
// time; none of that has anything to do with the question here.
jest.unstable_mockModule('../../database/redis.js', () => ({
    default: { get: async () => null, set: async () => {}, del: async () => {} },
}));
jest.unstable_mockModule('../../handlers/handleStatuspage.js', () => ({
    handleStatusPage: async () => {}, default: {},
}));
jest.unstable_mockModule('../../api/detect.js', () => ({
    detectSource: async () => 'SELF_HOSTED', classifyHeaders: () => null, default: {},
}));

const buildCommand = (await import('../../discord/commands/livck.js')).default;

const models = {
    Subscription: {
        findOne: async () => { throw new Error('the handler must never get this far'); },
        findAll: async () => { throw new Error('the handler must never get this far'); },
        destroy: async () => { throw new Error('the handler must never get this far'); },
    },
    Statuspage: { findOne: async () => { throw new Error('the handler must never get this far'); } },
    CustomLink: { findAll: async () => { throw new Error('the handler must never get this far'); } },
    RoleMention: { findAll: async () => { throw new Error('the handler must never get this far'); } },
};

const command = buildCommand(models);

const makeInteraction = ({ manageGuild, customId, values = [] }) => {
    const replies = [];
    return {
        replies,
        locale: 'de',
        guildId: 'guild-1',
        customId,
        values,
        components: [],
        memberPermissions: { has: (flag) => manageGuild && flag === 'ManageGuild' },
        member: { permissions: { has: (flag) => manageGuild && flag === 'ManageGuild' } },
        reply: async (payload) => { replies.push(payload); },
        deferUpdate: async () => { throw new Error('the handler must never get this far'); },
        deferReply: async () => { throw new Error('the handler must never get this far'); },
        editReply: async () => { throw new Error('the handler must never get this far'); },
        followUp: async () => { throw new Error('the handler must never get this far'); },
        showModal: async () => { throw new Error('the handler must never get this far'); },
        update: async () => { throw new Error('the handler must never get this far'); },
    };
};

/** Every component id that changes or reveals something. */
const DESTRUCTIVE = [
    'unsub_1',
    'delete_sub_1',
    'delete_link_1',
    'remove_role_1',
    'edit_api_token_1',
    'update_locale_1',
    'update_layout_1',
    'add_link_1',
    'add_role_1',
];

describe('a member without Manage Server', () => {
    test.each(DESTRUCTIVE)('cannot use the %s button', async (customId) => {
        // Every mock throws, so reaching the database at all fails the test.
        const interaction = makeInteraction({ manageGuild: false, customId });

        await command.handleComponentInteraction(interaction, {});

        expect(interaction.replies).toHaveLength(1);
        expect(interaction.replies[0].content).toMatch(/Berechtigung/);
        // Ephemeral, so the refusal is not broadcast to the channel.
        expect(interaction.replies[0].flags).toBe(64);
    });

    test('cannot submit the subscribe modal either', async () => {
        // The modal is where a subscription is actually created, and where an API token is
        // actually written.
        const interaction = makeInteraction({ manageGuild: false, customId: 'subscribe_complete_modal' });

        await command.handleModalSubmit(interaction, {});

        expect(interaction.replies).toHaveLength(1);
        expect(interaction.replies[0].content).toMatch(/Berechtigung/);
    });

    test('cannot submit an API token change', async () => {
        const interaction = makeInteraction({ manageGuild: false, customId: 'edit_api_token_submit_1' });

        await command.handleModalSubmit(interaction, {});

        expect(interaction.replies).toHaveLength(1);
    });

    test('is refused even for a read-only navigation button', async () => {
        // Guarding the whole handler rather than a list of ids is what keeps a button added
        // next month covered by default.
        const interaction = makeInteraction({ manageGuild: false, customId: 'refresh_list' });

        await command.handleComponentInteraction(interaction, {});

        expect(interaction.replies).toHaveLength(1);
    });
});

describe('a member with Manage Server', () => {
    test('is let through to the handler', async () => {
        // Proof the guard is not simply refusing everyone: the mocked lookup is reached, and
        // it is the lookup that throws, not the permission check.
        const interaction = makeInteraction({ manageGuild: true, customId: 'delete_sub_1' });

        await expect(command.handleComponentInteraction(interaction, {}))
            .rejects.toThrow('the handler must never get this far');
        expect(interaction.replies).toHaveLength(0);
    });

    test('is not blocked when only the raw member permissions are available', async () => {
        // `memberPermissions` is missing on an uncached member in some gateway states; the
        // GuildMember's own permissions have to carry it.
        const interaction = makeInteraction({ manageGuild: true, customId: 'refresh_list' });
        delete interaction.memberPermissions;

        await expect(command.handleComponentInteraction(interaction, {}))
            .rejects.toThrow('the handler must never get this far');
    });
});
