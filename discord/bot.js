import { REST, Routes } from 'discord.js';
import { Client, GatewayIntentBits, Collection } from 'discord.js';
import fs from 'fs';
import path from 'path';

const registerCommands = async (commandsFolder, models) => {
    const commands = [];

    for (const file of fs.readdirSync(commandsFolder).filter(file => file.endsWith('.js'))) {
        const command = (await import(path.join(commandsFolder, file))).default(models)
        commands.push(command.data);
    }

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: commands })
        .then(() => console.log(`Successfully reloaded application (/) commands: ${commands.map(command => command.name).join(', ')}`))
        .catch(error => console.error(`Failed to register commands: ${error}`));

    return commands;
};

const initializeBot = async (commandsFolder, models) => {
    if (!process.env.DISCORD_BOT_TOKEN || !process.env.DISCORD_CLIENT_ID) {
        console.error('Missing environment variables: DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID.');
        process.exit(1);
    }

    const client = new Client({
        intents: [GatewayIntentBits.Guilds],
        rest: {
            // Emit invalidRequestWarning every N invalid responses instead of never (the
            // default of 0 disables the warning entirely). 250 gives ~40 warnings before the
            // 10,000 ban threshold, which is early enough to react and rare enough to read.
            invalidRequestWarningInterval: 250,
        },
    });

    // Load commands into client
    client.commands = new Collection();
    const commandFiles = fs.readdirSync(commandsFolder).filter(file => file.endsWith('.js'));

    for (const file of commandFiles) {
        const command = (await import(path.join(commandsFolder, file))).default(models);
        client.commands.set(command.data.name, command);
    }

    client.once('ready', () => {
        console.log(`Logged in as ${client.user.tag}!`);
    });

    /**
     * Discord allows a bot 50 requests per second overall, plus per-route buckets keyed by
     * channel. discord.js queues rather than throwing when a limit is reached, so the only
     * symptom used to be status updates quietly arriving later and later — with nothing in
     * the logs. This surfaces it.
     */
    client.rest.on('rateLimited', (info) => {
        console.warn(
            `[Discord] Rate limited: ${info.global ? 'global' : info.route} — waiting ${info.timeToReset}ms ` +
            `(limit ${info.limit}, method ${info.method})`
        );
    });

    /**
     * The one that actually gets a bot banned.
     *
     * Discord counts 401, 403 and 429 responses as INVALID REQUESTS and blocks the bot's IP at
     * the Cloudflare layer once ~10,000 of them accumulate inside 10 minutes — a ban that
     * outlives a restart. The bot produces exactly those codes in normal operation whenever a
     * channel was deleted or its permissions were withdrawn (10003 / 50001), and it removes the
     * subscription when that happens, so it self-heals. But a mass event — a large guild wiping
     * a category, a permission change across many servers — can spike the count.
     *
     * discord.js emits this once per `invalidRequestWarningInterval` requests. It is the only
     * advance warning there is.
     */
    client.rest.on('invalidRequestWarning', (info) => {
        console.error(
            `[Discord] INVALID REQUEST WARNING: ${info.count} invalid requests, ` +
            `${info.remainingTime}ms left in the window. Approaching the Cloudflare ban threshold.`
        );
    });

    client.on('interactionCreate', async (interaction) => {
        // Handle autocomplete
        if (interaction.isAutocomplete()) {
            const command = client.commands.get(interaction.commandName);

            if (!command || typeof command.autocomplete !== 'function') {
                return;
            }

            try {
                await command.autocomplete(interaction, client);
            } catch (error) {
                console.error(`Error handling autocomplete for ${interaction.commandName}: ${error}`);
            }
            return;
        }

        // Handle modal submits
        if (interaction.isModalSubmit()) {
            const livckCommand = client.commands.get('livck');

            if (livckCommand && typeof livckCommand.handleModalSubmit === 'function') {
                try {
                    await livckCommand.handleModalSubmit(interaction, client);
                } catch (error) {
                    console.error(`Error handling modal submit: ${error}`);
                    if (!interaction.replied && !interaction.deferred) {
                        await interaction.reply({ content: 'There was an error handling that modal!', ephemeral: true });
                    }
                }
            }
            return;
        }

        // Handle slash commands
        if (interaction.isChatInputCommand()) {
            const command = client.commands.get(interaction.commandName);

            if (!command) {
                console.warn(`Unhandled command: ${interaction.commandName}`);
                await interaction.reply({ content: 'Unknown command!', ephemeral: true });
                return;
            }

            try {
                await command.execute(interaction, client);
            } catch (error) {
                console.error(`Error executing command ${interaction.commandName}: ${error}`);
                await interaction.reply({ content: 'There was an error executing that command!', ephemeral: true });
            }
            return;
        }

        // Handle select menus and buttons
        if (interaction.isStringSelectMenu() || interaction.isButton() || interaction.isRoleSelectMenu()) {
            // Find the command that owns this interaction
            const livckCommand = client.commands.get('livck');

            if (livckCommand && typeof livckCommand.handleComponentInteraction === 'function') {
                try {
                    await livckCommand.handleComponentInteraction(interaction, client);
                } catch (error) {
                    console.error(`Error handling component interaction: ${error}`);
                    if (!interaction.replied && !interaction.deferred) {
                        await interaction.reply({ content: 'There was an error handling that interaction!', ephemeral: true });
                    }
                }
            }
        }
    });

    try {
        await client.login(process.env.DISCORD_BOT_TOKEN);
        console.log('Bot logged in successfully.');
    } catch (error) {
        console.error(`Failed to login bot: ${error}`);
    }

    return client;
};

const bot = async (database) => {
    const commandsFolder = path.resolve('./discord/commands');
    await registerCommands(commandsFolder, database);
    return await initializeBot(commandsFolder, database);
};

export default bot;
