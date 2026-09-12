/**
 * Registering the slash commands.
 *
 * Discord validates the set as a WHOLE: one oversized localized description and the bot ends
 * up with no commands at all. That used to be logged and shrugged off, so it came up looking
 * healthy with nothing to type — which is why the failure is now fatal, and why that is worth
 * a test rather than a comment.
 */

import { jest } from '@jest/globals';

const rest = { put: null, calls: [] };

/**
 * The REAL discord.js with one class swapped.
 *
 * Rebuilding its surface by hand is a losing game — the command files pull in a dozen builders
 * — and a hand-made double would drift from the library the bot actually registers against.
 * Resolved before the mock is registered, so this is the genuine module.
 */
const realDiscord = await import('discord.js');

jest.unstable_mockModule('discord.js', () => ({
    ...realDiscord,
    REST: class {
        setToken() { return this; }
        async put(route, body) {
            rest.calls.push({ route, body });
            if (rest.put instanceof Error) throw rest.put;
            return rest.put ?? [];
        }
    },
}));

// Loading the command files reaches database/redis.js, which builds its URL at import time.
jest.unstable_mockModule('../../database/redis.js', () => ({
    default: { get: async () => null, set: async () => {}, del: async () => {} },
}));

jest.unstable_mockModule('../../util/discordPatch.js', () => ({
    requireModalSupport: () => {}, checkModalSupport: () => [], default: {},
}));

const { registerCommands } = await import('../../discord/bot.js');

const withCapturedExit = async (fn) => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((code) => {
        throw Object.assign(new Error('process.exit'), { code });
    });
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    const logs = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
        let exited = null;
        try {
            await fn();
        } catch (error) {
            if (error.message !== 'process.exit') throw error;
            exited = error.code;
        }
        return { exited, said: errors.mock.calls.map((c) => c.join(' ')).join('\n') };
    } finally {
        exit.mockRestore();
        errors.mockRestore();
        logs.mockRestore();
    }
};

const FOLDER = new URL('../../discord/commands', import.meta.url).pathname;

beforeEach(() => {
    rest.put = null;
    rest.calls = [];
    process.env.DISCORD_CLIENT_ID = '123';
    process.env.DISCORD_BOT_TOKEN = 'token';
});

describe('the command set', () => {
    test('every command file in the folder is registered', async () => {
        await withCapturedExit(() => registerCommands(FOLDER, {}));

        expect(rest.calls).toHaveLength(1);
        const names = rest.calls[0].body.body.map((c) => c.name).sort();
        expect(names).toEqual(['livck', 'livck-ping']);
    });

    test('is sent to the application, not to a guild', async () => {
        // Guild-scoped registration would leave every other server without commands.
        await withCapturedExit(() => registerCommands(FOLDER, {}));

        expect(rest.calls[0].route).toBe('/applications/123/commands');
    });

    test('carries the localizations, and every one is inside Discord limits', async () => {
        await withCapturedExit(() => registerCommands(FOLDER, {}));

        for (const command of rest.calls[0].body.body) {
            expect(command.description.length).toBeLessThanOrEqual(100);
            for (const text of Object.values(command.description_localizations ?? {})) {
                expect(text.length).toBeLessThanOrEqual(100);
            }
            for (const option of command.options ?? []) {
                expect(option.description.length).toBeLessThanOrEqual(100);
                for (const text of Object.values(option.description_localizations ?? {})) {
                    expect(text.length).toBeLessThanOrEqual(100);
                }
            }
        }
    });

    test('a rejected registration ends the process instead of being logged away', async () => {
        rest.put = Object.assign(new Error('Invalid Form Body'), {
            rawError: { code: 50035, errors: { '0': { description: { _errors: [{ code: 'BASE_TYPE_MAX_LENGTH' }] } } } },
        });

        const { exited, said } = await withCapturedExit(() => registerCommands(FOLDER, {}));

        expect(exited).toBe(1);
        // The raw error is what says WHICH field Discord objected to.
        expect(said).toContain('BASE_TYPE_MAX_LENGTH');
    });
});
