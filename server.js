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
const { startUpdateLoop, stopUpdateLoop } = await import('./services/updateLoop.js');

const client = await bot(models);

startUpdateLoop(client);

// Stopping on request rather than being killed — see util/shutdown.js.
const { createShutdown } = await import('./util/shutdown.js');
const cache = (await import('./database/redis.js')).default;

const shutdown = createShutdown({
    stopLoop: stopUpdateLoop,
    close: [
        () => client.destroy(),
        () => models.database.close(),
        () => (cache.isOpen ? cache.quit() : Promise.resolve()),
    ],
});

for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => { shutdown(signal); });
}
