import { REST, Routes } from 'discord.js';
import { Client, Events, GatewayIntentBits, Collection } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { routeInteraction } from './interactionRouter.js';
import { requireModalSupport } from '../util/modalSupport.js';
import { createRestPolicy } from './restPolicy.js';
import { watchGateway } from './gatewayWatch.js';

/**
 * Collect every command definition and register the set with Discord.
 *
 * Exported so it can be tested: Discord validates the set as a WHOLE, so this either works
 * completely or leaves the bot with no commands at all, and that is worth holding in place.
 * `initializeBot` below is not — it opens a gateway connection, and what it does is verified
 * by the Docker run and the live Discord suite rather than by a double.
 */
export const registerCommands = async (commandsFolder, models) => {
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

/**
 * The client, with everything that decides how it treats Discord: the REST policy and the one
 * advance warning before a Cloudflare ban. No connection is opened.
 *
 * Separate from initializeBot so a test can hold it in place. The loop tests build their own
 * client, which proved what the policy does and not that the bot uses it — dropping the
 * `rest:` line here would have brought back the 429 retried for ever with every suite green.
 */
export const createClient = () => {
    // A 429 is final rather than retried for ever, and refused requests are logged by route.
    // See discord/restPolicy.js.
    const restPolicy = createRestPolicy();

    const client = new Client({
        intents: [GatewayIntentBits.Guilds],
        rest: restPolicy.options,
    });

    restPolicy.attach(client.rest);
    client.restPolicy = restPolicy;

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

    return client;
};

const initializeBot = async (commandsFolder, models, { onGatewayLost } = {}) => {
    if (!process.env.DISCORD_BOT_TOKEN || !process.env.DISCORD_CLIENT_ID) {
        console.error('Missing environment variables: DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID.');
        process.exit(1);
    }

    // Asked of the library, not of its source: node_modules restored from a build cache never
    // runs postinstall, and the bot would come up healthy and missing the only way to add a
    // status page. See util/modalSupport.js.
    requireModalSupport();

    const client = createClient();

    // Load commands into client
    client.commands = new Collection();
    const commandFiles = fs.readdirSync(commandsFolder).filter(file => file.endsWith('.js'));

    for (const file of commandFiles) {
        const command = (await import(path.join(commandsFolder, file))).default(models);
        client.commands.set(command.data.name, command);
    }

    client.once(Events.ClientReady, () => {
        console.log(`Logged in as ${client.user.tag}!`);
    });

    // routeInteraction resolves even when a handler fails. The catch is for a bug in the router
    // itself: it would otherwise be an unhandled rejection, which ends the process.
    client.on(Events.InteractionCreate, (interaction) => {
        routeInteraction(interaction, client).catch((error) => {
            console.error('[Discord] Interaction routing failed:', error);
        });
    });

    // Before login, so a first ready that never arrives counts too. See discord/gatewayWatch.js.
    client.gatewayWatch = watchGateway(client, {
        onFatal: (reason) => (onGatewayLost ? onGatewayLost(reason) : process.exit(1)),
    });

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

/**
 * @param {object} database - the models
 * @param {{onGatewayLost?: (reason: string) => void}} [options] - called once when the gateway
 *   is not coming back; the process should leave with a failure code. See discord/gatewayWatch.js.
 */
const bot = async (database, options = {}) => {
    const commandsFolder = path.resolve('./discord/commands');
    await registerCommands(commandsFolder, database);
    return await initializeBot(commandsFolder, database, options);
};

export default bot;
