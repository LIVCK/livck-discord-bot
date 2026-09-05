/**
 * Routing one incoming interaction to the code that answers it.
 *
 * WHY THIS IS ITS OWN FILE
 *
 * It used to be an inline listener in bot.js, so it could only run with a real Discord
 * connection — and it contained a bug that took the whole process down.
 *
 * THE BUG: every catch answered with `interaction.reply()`. discord.js THROWS
 * `InteractionAlreadyReplied` when the interaction was already replied to or deferred, and
 * `/livck subscribe` defers immediately. So any error inside a deferred command threw a second
 * time, out of an async event listener, where nothing catches it — and since Node 15 an
 * unhandled rejection terminates the process. One failing interaction in one guild took the
 * bot down for every guild, and the user who triggered it saw nothing at all.
 *
 * Replying now goes through `respondWithError`, which picks reply or followUp depending on the
 * state Discord is actually in, and swallows its own failure: by then the interaction token
 * may simply have expired, and there is nothing useful left to say.
 */

import logger from '../util/logger.js';

/** Discord: this interaction's token is no longer valid (15-minute lifetime). */
const UNKNOWN_INTERACTION = 10062;

/**
 * Tell the user something went wrong, whatever state the interaction is in.
 *
 * Never throws. It is called from a catch block inside an event listener, which is precisely
 * the place where a second throw has nowhere to go.
 */
export const respondWithError = async (interaction, message) => {
    try {
        const payload = { content: message, flags: 64 /* EPHEMERAL */ };

        if (interaction.replied || interaction.deferred) {
            await interaction.followUp(payload);
        } else {
            await interaction.reply(payload);
        }
    } catch (error) {
        if (error?.code === UNKNOWN_INTERACTION) {
            logger.debug('[Discord] Interaction expired before the error notice could be sent');
            return;
        }
        logger.warn(`[Discord] Could not deliver the error notice: ${error?.message ?? error}`);
    }
};

/**
 * Dispatch an interaction. Resolves even when the handler failed.
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {import('discord.js').Client} client - carries `client.commands`
 */
export const routeInteraction = async (interaction, client) => {
    if (interaction.isAutocomplete()) {
        const command = client.commands.get(interaction.commandName);
        if (!command || typeof command.autocomplete !== 'function') return;

        try {
            await command.autocomplete(interaction, client);
        } catch (error) {
            // An autocomplete cannot be answered twice and has no error surface of its own;
            // the user simply sees no suggestions.
            logger.error(`[Discord] Autocomplete for ${interaction.commandName} failed:`, error);
        }
        return;
    }

    if (interaction.isModalSubmit()) {
        const command = client.commands.get('livck');
        if (!command || typeof command.handleModalSubmit !== 'function') return;

        try {
            await command.handleModalSubmit(interaction, client);
        } catch (error) {
            logger.error('[Discord] Modal submit failed:', error);
            await respondWithError(interaction, 'There was an error handling that modal!');
        }
        return;
    }

    if (interaction.isChatInputCommand()) {
        const command = client.commands.get(interaction.commandName);

        if (!command) {
            logger.warn(`[Discord] Unhandled command: ${interaction.commandName}`);
            await respondWithError(interaction, 'Unknown command!');
            return;
        }

        try {
            await command.execute(interaction, client);
        } catch (error) {
            logger.error(`[Discord] Command ${interaction.commandName} failed:`, error);
            await respondWithError(interaction, 'There was an error executing that command!');
        }
        return;
    }

    if (interaction.isStringSelectMenu?.() || interaction.isButton?.() || interaction.isRoleSelectMenu?.()) {
        const command = client.commands.get('livck');
        if (!command || typeof command.handleComponentInteraction !== 'function') return;

        try {
            await command.handleComponentInteraction(interaction, client);
        } catch (error) {
            logger.error('[Discord] Component interaction failed:', error);
            await respondWithError(interaction, 'There was an error handling that interaction!');
        }
    }
};

export default { routeInteraction, respondWithError };
