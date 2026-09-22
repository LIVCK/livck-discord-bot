/**
 * `/livck-ping`.
 *
 * Small, and the only command that works in a DM — so it is also the only one whose reply is
 * built without a guild, a subscription or a status page behind it.
 */

import { jest } from '@jest/globals';

jest.unstable_mockModule('../../database/redis.js', () => ({
    default: { get: async () => null, set: async () => {}, del: async () => {} },
}));

const buildPing = (await import('../../discord/commands/ping.js')).default;

const command = buildPing({});

const makeInteraction = (locale) => {
    const replies = [];
    return { locale, replies, reply: async (payload) => { replies.push(payload); } };
};

describe('the command definition', () => {
    test('is usable in a DM, unlike the rest', () => {
        expect(command.data.dm_permission).toBe(true);
    });

    test('has a description inside Discord limits, in every language it offers', () => {
        expect(command.data.description.length).toBeGreaterThan(0);
        expect(command.data.description.length).toBeLessThanOrEqual(100);

        for (const text of Object.values(command.data.description_localizations ?? {})) {
            expect(text.length).toBeLessThanOrEqual(100);
        }
    });
});

describe('the reply', () => {
    test.each([['de'], ['en']])('answers in %s', async (locale) => {
        const interaction = makeInteraction(locale);

        await command.execute(interaction, {});

        expect(interaction.replies).toHaveLength(1);
        expect(interaction.replies[0].content.length).toBeGreaterThan(0);
        expect(interaction.replies[0].content).not.toMatch(/commands\.ping/);
    });

    test('differs between the two languages', async () => {
        const de = makeInteraction('de');
        const en = makeInteraction('en');

        await command.execute(de, {});
        await command.execute(en, {});

        expect(de.replies[0].content).not.toBe(en.replies[0].content);
    });

    test('a language the bot does not have still gets a sentence, not a key', async () => {
        const interaction = makeInteraction('kl');

        await command.execute(interaction, {});

        expect(interaction.replies[0].content).not.toMatch(/commands\.ping/);
        expect(interaction.replies[0].content.length).toBeGreaterThan(0);
    });

    test('is ephemeral, so a ping does not sit in the channel', async () => {
        const interaction = makeInteraction('de');

        await command.execute(interaction, {});

        expect(interaction.replies[0].ephemeral ?? interaction.replies[0].flags).toBeTruthy();
    });

    test('an interaction with no locale at all does not throw', async () => {
        const interaction = { replies: [], reply: async (p) => { interaction.replies.push(p); } };

        await expect(command.execute(interaction, {})).resolves.toBeUndefined();
        expect(interaction.replies).toHaveLength(1);
    });
});
