/**
 * The three gates a boot has to pass, and what they do when it does not.
 *
 * Each of them ends the process. That is deliberate — every one guards a condition under which
 * the bot would otherwise come up looking healthy and do nothing useful — and it is also
 * exactly why they need testing: a gate that exits when it should not takes the bot down, and
 * one that does not exit when it should is worse than not being there.
 *
 * `process.exit` is replaced rather than called, because a test that really exits takes the
 * runner with it.
 */

import { jest } from '@jest/globals';
import { missingEnv, requireEnv, REQUIRED } from '../../util/env.js';
import { checkModalSupport, requireModalSupport } from '../../util/discordPatch.js';

/** Run `fn` with process.exit and the console captured. */
const withCapturedExit = (fn) => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((code) => {
        throw Object.assign(new Error('process.exit'), { code });
    });
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
        let exited = null;
        try {
            fn();
        } catch (error) {
            if (error.message !== 'process.exit') throw error;
            exited = error.code;
        }
        return { exited, said: errors.mock.calls.map((c) => c.join(' ')).join('\n') };
    } finally {
        exit.mockRestore();
        errors.mockRestore();
    }
};

const complete = () => ({
    DISCORD_BOT_TOKEN: 't', DISCORD_CLIENT_ID: '1',
    DB_HOST: 'db', DB_DATABASE: 'bot', DB_USERNAME: 'root',
    REDIS_HOST: 'redis', REDIS_PORT: '6379',
});

describe('the configuration gate', () => {
    test('lets a complete environment through without exiting', () => {
        const { exited } = withCapturedExit(() => requireEnv(complete()));
        expect(exited).toBeNull();
    });

    test('exits non-zero and names every missing variable at once', () => {
        // One restart per missing variable would be a miserable way to configure a bot.
        const { exited, said } = withCapturedExit(() => requireEnv({}));

        expect(exited).toBe(1);
        for (const name of REQUIRED) expect(said).toContain(name);
        expect(said).toContain('.env.example');
    });

    test('treats a blank value as missing', () => {
        const { exited, said } = withCapturedExit(() => requireEnv({ ...complete(), REDIS_HOST: '  ' }));

        expect(exited).toBe(1);
        expect(said).toContain('REDIS_HOST');
        expect(missingEnv({ ...complete(), REDIS_HOST: '  ' })).toEqual(['REDIS_HOST']);
    });
});

describe('the modal-support gate', () => {
    test('lets the installed discord.js through', () => {
        expect(checkModalSupport()).toEqual([]);

        const { exited } = withCapturedExit(() => requireModalSupport());
        expect(exited).toBeNull();
    });

    test('when the patch is missing it names the command that fixes it', async () => {
        // The realistic case is node_modules restored from a build cache, where postinstall
        // never ran. Simulated by breaking transformComponent for the length of the test.
        const { ModalSubmitInteraction } = await import('discord.js');
        const original = ModalSubmitInteraction.transformComponent;

        ModalSubmitInteraction.transformComponent = (raw) => ({
            value: raw.value, type: raw.type, customId: raw.custom_id,
        });

        try {
            const problems = checkModalSupport();
            expect(problems.length).toBeGreaterThan(0);
            expect(problems.join(' ')).toMatch(/Type 18|subscribe/i);

            const { exited, said } = withCapturedExit(() => requireModalSupport());
            expect(exited).toBe(1);
            expect(said).toContain('scripts/patch-discordjs.js');
        } finally {
            ModalSubmitInteraction.transformComponent = original;
        }
    });

    test('a library that throws is reported rather than crashing the boot', async () => {
        const { ModalSubmitInteraction } = await import('discord.js');
        const original = ModalSubmitInteraction.transformComponent;

        ModalSubmitInteraction.transformComponent = () => { throw new Error('gone'); };

        try {
            expect(checkModalSupport().join(' ')).toContain('gone');
        } finally {
            ModalSubmitInteraction.transformComponent = original;
        }
    });
});
