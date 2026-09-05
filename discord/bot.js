import { REST, Routes } from 'discord.js';
import { Client, GatewayIntentBits, Collection } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { routeInteraction } from './interactionRouter.js';

const registerCommands = async (commandsFolder, models) => {
    const commands = [];

    for (const file of fs.readdirSync(commandsFolder).filter(file => file.endsWith('.js'))) {
        const command = (await import(path.join(commandsFolder, file))).default(models)
        commands.push(command.data);
    }

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

    try {
        await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: commands });
        console.log(`Successfully reloaded application (/) commands: ${commands.map((command) => command.name).join(', ')}`);
    } catch (error) {
        // Discord rejects the command set as a WHOLE — one oversized localized description and
        // every command is gone. This used to be logged and shrugged off, so the bot came up
        // looking healthy with no slash commands at all and nothing said why. It is fatal
        // instead: the process supervisor restarts, and somebody sees it.
        console.error('Failed to register commands:', error?.rawError ? JSON.stringify(error.rawError) : error);
        process.exit(1);
    }

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

    client.on('interactionCreate', (interaction) => routeInteraction(interaction, client));

    try {
        await client.login(process.env.DISCORD_BOT_TOKEN);
        console.log('Bot logged in successfully.');
    } catch (error) {
        // Fatal, deliberately. A client that never logged in still satisfies every call the
        // update loop makes — it just fails each one — so the bot would keep polling status
        // pages for ever and deliver nothing, looking healthy the whole time. Exiting hands
        // the problem to whatever supervises the process, which can restart and alert.
        console.error(`Failed to login bot: ${error}`);
        process.exit(1);
    }

    return client;
};

const bot = async (database) => {
    const commandsFolder = path.resolve('./discord/commands');
    await registerCommands(commandsFolder, database);
    return await initializeBot(commandsFolder, database);
};

export default bot;
