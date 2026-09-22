/**
 * The interaction router — and the crash it used to cause.
 *
 * Every catch answered with `interaction.reply()`. discord.js throws
 * `InteractionAlreadyReplied` once an interaction has been replied to or deferred, and
 * `/livck subscribe` defers straight away. So an error inside a deferred command threw a
 * SECOND time, out of an async event listener, where nothing catches it — and since Node 15
 * an unhandled rejection terminates the process. One failing interaction in one guild took
 * the bot down for every guild.
 */

import { routeInteraction, respondWithError } from '../../discord/interactionRouter.js';

/** What discord.js actually does — the behaviour the old code walked into. */
const alreadyReplied = () =>
    Object.assign(new Error('The reply to this interaction has already been sent or deferred.'), {
        code: 'InteractionAlreadyReplied',
    });

const makeInteraction = (kind, overrides = {}) => {
    const state = {
        replied: false,
        deferred: false,
        replies: [],
        followUps: [],
        commandName: 'livck',
        isAutocomplete: () => kind === 'autocomplete',
        isModalSubmit: () => kind === 'modal',
        isChatInputCommand: () => kind === 'command',
        isStringSelectMenu: () => kind === 'component',
        isButton: () => false,
        isRoleSelectMenu: () => false,
        reply: async (payload) => {
            if (state.replied || state.deferred) throw alreadyReplied();
            state.replied = true;
            state.replies.push(payload);
        },
        followUp: async (payload) => { state.followUps.push(payload); },
        ...overrides,
    };
    return state;
};

const clientWith = (command) => ({ commands: new Map([['livck', command]]) });

describe('a handler that throws', () => {
    test('does not take the process down when the interaction was deferred', async () => {
        // The exact production shape: /livck subscribe defers, then something fails.
        const interaction = makeInteraction('command');
        interaction.deferred = true;

        const client = clientWith({
            execute: async () => { throw new Error('database is down'); },
        });

        await expect(routeInteraction(interaction, client)).resolves.toBeUndefined();

        // And the user is actually told, rather than staring at a spinner.
        expect(interaction.followUps).toHaveLength(1);
        expect(interaction.followUps[0].flags).toBe(64);
    });

    test('replies directly when nothing has been sent yet', async () => {
        const interaction = makeInteraction('command');
        const client = clientWith({ execute: async () => { throw new Error('boom'); } });

        await routeInteraction(interaction, client);

        expect(interaction.replies).toHaveLength(1);
        expect(interaction.followUps).toHaveLength(0);
    });

    test('survives a component interaction that already replied', async () => {
        const interaction = makeInteraction('component');
        interaction.replied = true;

        const client = clientWith({
            handleComponentInteraction: async () => { throw new Error('boom'); },
        });

        await expect(routeInteraction(interaction, client)).resolves.toBeUndefined();
        expect(interaction.followUps).toHaveLength(1);
    });

    test('survives a modal submit that already deferred', async () => {
        const interaction = makeInteraction('modal');
        interaction.deferred = true;

        const client = clientWith({ handleModalSubmit: async () => { throw new Error('boom'); } });

        await expect(routeInteraction(interaction, client)).resolves.toBeUndefined();
        expect(interaction.followUps).toHaveLength(1);
    });

    test('an autocomplete failure is swallowed without an attempted reply', async () => {
        // An autocomplete has no error surface — replying to it is itself an error.
        const interaction = makeInteraction('autocomplete');
        const client = clientWith({ autocomplete: async () => { throw new Error('boom'); } });

        await expect(routeInteraction(interaction, client)).resolves.toBeUndefined();
        expect(interaction.replies).toHaveLength(0);
        expect(interaction.followUps).toHaveLength(0);
    });
});

describe('respondWithError', () => {
    test('gives up quietly when the interaction token has expired', async () => {
        // 15 minutes after the click there is nobody left to tell.
        const interaction = {
            replied: false,
            deferred: false,
            reply: async () => { throw Object.assign(new Error('Unknown interaction'), { code: 10062 }); },
            followUp: async () => {},
        };

        await expect(respondWithError(interaction, 'anything')).resolves.toBeUndefined();
    });

    test('never throws, whatever Discord answers', async () => {
        const interaction = {
            replied: true,
            deferred: false,
            reply: async () => { throw new Error('nope'); },
            followUp: async () => { throw new Error('also nope'); },
        };

        await expect(respondWithError(interaction, 'anything')).resolves.toBeUndefined();
    });
});

describe('routing', () => {
    test('an unknown command is answered rather than ignored', async () => {
        const interaction = makeInteraction('command', { commandName: 'ghost' });

        await routeInteraction(interaction, { commands: new Map() });

        expect(interaction.replies).toHaveLength(1);
    });

    test('a component interaction with no handler is a no-op', async () => {
        const interaction = makeInteraction('component');

        await expect(routeInteraction(interaction, { commands: new Map() })).resolves.toBeUndefined();
        expect(interaction.replies).toHaveLength(0);
    });
});
