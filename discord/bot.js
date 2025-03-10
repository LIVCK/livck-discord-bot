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
        if (!interaction.isChatInputCommand()) return;

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
