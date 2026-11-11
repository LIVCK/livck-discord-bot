import dotenv from 'dotenv';

dotenv.config();

// BEFORE anything else is imported. `models/index.js` opens a database connection and the
// command modules open a Redis one at import time, and a missing variable there surfaces as
// `TypeError: Invalid URL` from inside node-redis rather than as the name of what is missing.
const { requireEnv } = await import('./util/env.js');
requireEnv();

const models = (await import('./models/index.js')).default;

// Before the loop touches a single column. Forgetting to migrate is not a loud failure — the
// loop selects columns that do not exist, every query fails, and the process stays up looking
// healthy. See util/migrateOnStart.js.
const { migrateOnStart } = await import('./util/migrateOnStart.js');
try {
    const applied = await migrateOnStart();
    if (applied.length === 0) console.log('[Migrate] Schema is up to date.');
} catch (error) {
    console.error('[Migrate] Failed, refusing to start:', error);
    process.exit(1);
}

const bot = (await import('./discord/bot.js')).default;
const { startUpdateLoop, stopUpdateLoop, whenCycleDone } = await import('./services/updateLoop.js');
const { drainDeliveries } = await import('./util/delivery.js');

// Bound late: the shutdown needs the client to close it. A gateway lost before that is a
// failed login, which bot.js already treats as fatal.
let shutdown = null;
const client = await bot(models, {
    onGatewayLost: (reason) => (shutdown ? shutdown(`Discord gateway ${reason}`, 1) : process.exit(1)),
});

startUpdateLoop(client);

// Stopping on request rather than being killed — see util/shutdown.js.
const { createShutdown } = await import('./util/shutdown.js');
const cache = (await import('./database/redis.js')).default;

shutdown = createShutdown({
    stopLoop: () => {
        stopUpdateLoop();
        // Before client.destroy(), which closes the gateway and would read as a lost connection.
        client.gatewayWatch?.stop();
    },
    // The cycle first, then whatever it left running: see util/shutdown.js.
    drain: [async () => { await whenCycleDone(); await drainDeliveries(); }],
    close: [
        () => client.destroy(),
        () => models.database.close(),
        () => (cache.isOpen ? cache.quit() : Promise.resolve()),
    ],
});

for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => { shutdown(signal); });
}
