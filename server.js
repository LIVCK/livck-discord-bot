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

/**
 * Shut down when asked, instead of being killed.
 *
 * The cycle timer keeps Node's event loop alive, so a SIGTERM used to do nothing at all:
 * `docker stop` waited its ten seconds and then SIGKILLed the process — exit 137, on every
 * single deploy, with a cycle cut in half somewhere between sending a Discord message and
 * writing the row that remembers having sent it.
 *
 * Scheduling stops first, the in-flight cycle is given a moment to finish, then the gateway,
 * the database pool and Redis are closed. The hard deadline exists because a shutdown that
 * hangs is no better than one that never starts — after it, the process leaves anyway.
 */
const SHUTDOWN_DEADLINE_MS = Number(process.env.SHUTDOWN_DEADLINE_MS || 5000);
let shuttingDown = false;

const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`[Shutdown] ${signal} received, stopping.`);
    setTimeout(() => {
        console.warn('[Shutdown] Deadline reached, exiting anyway.');
        process.exit(0);
    }, SHUTDOWN_DEADLINE_MS).unref();

    stopUpdateLoop();

    const cache = (await import('./database/redis.js')).default;
    await Promise.allSettled([
        client.destroy(),
        models.database.close(),
        cache.isOpen ? cache.quit() : Promise.resolve(),
    ]);

    console.log('[Shutdown] Done.');
    process.exit(0);
};

for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => { shutdown(signal); });
}
