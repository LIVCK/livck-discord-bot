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

    const client = new Client({ intents: [GatewayIntentBits.Guilds] });

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
        if (interaction.isStringSelectMenu() || interaction.isButton()) {
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
