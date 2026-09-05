/**
 * The button and autocomplete paths of /livck.
 *
 * All four defects below were found by driving the real handlers with fake interactions that
 * enforce discord.js's actual state machine — `reply`/`deferUpdate` throw once the interaction
 * has been answered or deferred, exactly as
 * node_modules/discord.js/src/structures/interfaces/InteractionResponses.js does.
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

const buildCommand = (await import('../../discord/commands/livck.js')).default;
const { DISCORD_LIMITS } = await import('../../util/discordLimits.js');

const db = { subscriptions: [], links: [] };

const statuspage = (id = 1) => ({ id, name: `Status Page ${id}`, url: `https://s${id}.example.com` });

const models = {
    Subscription: {
        findOne: async ({ where }) => db.subscriptions.find(
            (s) => String(s.id) === String(where.id) && s.guildId === where.guildId
        ) ?? null,
        findAll: async ({ where }) => db.subscriptions.filter((s) => s.guildId === where.guildId),
        // Guild-scoped, so a stale id simply matches no rows — which is why the handler
        // reaches its lookup afterwards and has to cope with a null.
        update: async (_values, { where }) => {
            const row = db.subscriptions.find(
                (sub) => String(sub.id) === String(where.id) && sub.guildId === where.guildId
            );
            if (row) Object.assign(row, _values);
            return [row ? 1 : 0];
        },
        destroy: async () => 1,
    },
    Statuspage: { findOne: async () => null },
    CustomLink: {
        findOne: async ({ where }) => db.links.find((l) => String(l.id) === String(where.id)) ?? null,
        findAll: async ({ where }) => db.links.filter(
            (l) => String(l.subscriptionId) === String(where.subscriptionId)
        ),
    },
    RoleMention: { findAll: async () => [] },
};

const command = buildCommand(models);

/** Enforces the real reply state machine, so a double-defer fails the way Discord does. */
const makeInteraction = ({ customId, values = [], guildId = 'guild-1', deferred = false }) => {
    const state = {
        locale: 'de',
        guildId,
        customId,
        values,
        components: [],
        replied: false,
        deferred,
        replies: [],
        edits: [],
        followUps: [],
        memberPermissions: { has: (flag) => flag === 'ManageGuild' },
        guild: { channels: { cache: { get: () => ({ name: 'allgemein' }) } } },
        reply: async (payload) => {
            if (state.replied || state.deferred) throw new Error('InteractionAlreadyReplied');
            state.replied = true;
            state.replies.push(payload);
        },
        deferUpdate: async () => {
            if (state.replied || state.deferred) throw new Error('InteractionAlreadyReplied');
            state.deferred = true;
        },
        deferReply: async () => {
            if (state.replied || state.deferred) throw new Error('InteractionAlreadyReplied');
            state.deferred = true;
        },
        editReply: async (payload) => {
            if (typeof payload?.content === 'string' && payload.content.length > DISCORD_LIMITS.MESSAGE_CONTENT) {
                throw Object.assign(new Error('Invalid Form Body'), { code: 50035 });
            }
            state.edits.push(payload);
        },
        followUp: async (payload) => { state.followUps.push(payload); },
        update: async (payload) => { state.edits.push(payload); },
        showModal: async () => {},
    };
    return state;
};

beforeEach(() => {
    db.subscriptions = [{
        id: 1, guildId: 'guild-1', channelId: 'chan-1', locale: 'de', layout: 'DETAILED',
        eventTypes: { STATUS: true, NEWS: true }, Statuspage: statuspage(1),
    }];
    db.links = [];
});

describe('redrawing the link list after a deletion', () => {
    test('does not defer an interaction that is already deferred', async () => {
        // `delete_link_` defers and then re-enters this handler to redraw. The second
        // deferUpdate threw InteractionAlreadyReplied, so every link deletion ended in the
        // generic "There was an error handling that interaction!" — while the link WAS gone
        // from the database and the stale list still offered a Delete that then said "link
        // not found". `manage_roles_` had the guard all along; this one did not.
        const interaction = makeInteraction({ customId: 'manage_links_1', deferred: true });

        await expect(command.handleComponentInteraction(interaction, {})).resolves.toBeUndefined();
        expect(interaction.edits.length).toBeGreaterThan(0);
    });

    test('stays inside Discord 2000-character message limit with the maximum links', async () => {
        // This screen is the ONLY route to the per-link edit and delete controls, so a guild
        // that crossed the limit could never delete a link to get back under it.
        db.links = Array.from({ length: 25 }, (_, i) => ({
            id: i + 1, subscriptionId: 1, position: i,
            label: `Dokumentationsportal Nummer ${i + 1}`,
            url: `https://docs.example.com/${'segment/'.repeat(20)}${i + 1}`,
            emoji: '📘',
        }));

        const interaction = makeInteraction({ customId: 'manage_links_1' });
        await command.handleComponentInteraction(interaction, {});

        expect(interaction.edits).toHaveLength(1);
        expect(interaction.edits[0].content.length).toBeLessThanOrEqual(DISCORD_LIMITS.MESSAGE_CONTENT);
    });
});

describe('the /livck edit autocomplete', () => {
    const autocomplete = (value, guildId = 'guild-1') => {
        const responses = [];
        return {
            responses,
            interaction: {
                locale: 'de',
                guildId,
                guild: { channels: { cache: { get: () => ({ name: 'allgemein' }) } } },
                options: { getFocused: () => ({ name: 'subscription', value }) },
                respond: async (choices) => { responses.push(choices); },
            },
        };
    };

    test('finds a subscription past the twenty-fifth', async () => {
        // The limit used to be applied in SQL, BEFORE the text was matched — so the candidate
        // set was the first 25 rows, not the 25 best matches. Since `subscription` is a
        // required option whose id can only come from this list, subscriptions 26 and up could
        // not be edited at all: no layout, locale, link, role, token change, and no delete.
        db.subscriptions = Array.from({ length: 40 }, (_, i) => ({
            id: i + 1, guildId: 'guild-1', channelId: 'c', locale: 'de',
            Statuspage: statuspage(i + 1),
        }));

        const { interaction, responses } = autocomplete('Status Page 40');
        await command.autocomplete(interaction, {});

        expect(responses[0]).toHaveLength(1);
        expect(responses[0][0].value).toBe('40');
    });

    test('still returns at most twenty-five, which is Discord own cap', async () => {
        db.subscriptions = Array.from({ length: 40 }, (_, i) => ({
            id: i + 1, guildId: 'guild-1', channelId: 'c', locale: 'de',
            Statuspage: statuspage(i + 1),
        }));

        const { interaction, responses } = autocomplete('');
        await command.autocomplete(interaction, {});

        expect(responses[0]).toHaveLength(25);
    });

    test('one orphaned row does not empty the whole list', async () => {
        // A subscription whose status page is gone used to throw here and take every healthy
        // suggestion with it.
        db.subscriptions = [
            { id: 1, guildId: 'guild-1', channelId: 'c', locale: 'de', Statuspage: statuspage(1) },
            { id: 2, guildId: 'guild-1', channelId: 'c', locale: 'de', Statuspage: null },
        ];

        const { interaction, responses } = autocomplete('Status');
        await command.autocomplete(interaction, {});

        expect(responses[0]).toHaveLength(1);
    });
});

describe('a subscription that is gone by the time the button is pressed', () => {
    test.each(['update_locale_99', 'update_layout_99'])('%s says so instead of throwing', async (customId) => {
        // Open /livck edit twice, delete the subscription in one panel and act in the other.
        const interaction = makeInteraction({ customId, values: ['en'] });

        await expect(command.handleComponentInteraction(interaction, {})).resolves.toBeUndefined();
        expect(interaction.followUps.at(-1).content).toMatch(/nicht gefunden/i);
    });
});

describe('opening one link detail view', () => {
    test('reads the sibling links of the link own subscription, not of the id in the custom_id', async () => {
        // The link is verified against the guild; the id in the custom_id is only a value the
        // bot put there, and the two used to be read independently.
        db.subscriptions.push({
            id: 2, guildId: 'guild-2', channelId: 'chan-2', locale: 'de',
            Statuspage: statuspage(2),
        });
        db.links = [
            { id: 7, subscriptionId: 1, position: 0, label: 'Docs', url: 'https://a.example.com', emoji: null },
            { id: 8, subscriptionId: 2, position: 0, label: 'Fremd', url: 'https://b.example.com', emoji: null },
        ];

        const interaction = makeInteraction({ customId: 'select_link_2', values: ['link_7'] });

        await expect(command.handleComponentInteraction(interaction, {})).resolves.toBeUndefined();
        // Guild 1 owns link 7, so it is answered from guild 1's subscription.
        expect(JSON.stringify(interaction.edits)).toContain('Status Page 1');
        expect(JSON.stringify(interaction.edits)).not.toContain('Status Page 2');
    });
});
