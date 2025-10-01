import dotenv from 'dotenv';
import models from './models/index.js';
import bot from './discord/bot.js';
import { handleStatusPage } from "./handlers/handleStatuspage.js";
import { handleAlerts } from "./handlers/handleAlerts.js";
import cache from './database/redis.js';
import StatuspagePauseManager from './services/statuspagePauseManager.js';

dotenv.config();

const client = await bot(models)

const BATCH_SIZE = 100;
const LOCK_TTL = 20;
const INTERVAL = 15 * 1000;

const scheduleStatusPageUpdates = async (client) => {
    try {
        const statuspages = await models.Statuspage.findAll({
            attributes: ['id', 'url', 'paused', 'pauseReason']
        });

        const activePages = statuspages.filter(sp => !sp.paused);
        const pausedPages = statuspages.filter(sp => sp.paused);

        console.log(`[UpdateLoop] Starting update for ${activePages.length} active statuspages (${pausedPages.length} paused)`);

        for (let i = 0; i < activePages.length; i += BATCH_SIZE) {
            const batch = activePages.slice(i, i + BATCH_SIZE);
            console.log(`[UpdateLoop] Processing batch ${i / BATCH_SIZE + 1} (${batch.length} pages)`);

            const results = await Promise.allSettled(batch.map(async (statuspage) => {
                let cacheKey = `dc-bot:statuspage:${statuspage.id}`;
                let cacheValue = await cache.get(cacheKey) || false;
                if (cacheValue) {
                    console.log(`[UpdateLoop] Skipping ${statuspage.url} (cached)`);
                    return { skipped: true };
                }

                console.log(`[UpdateLoop] Updating ${statuspage.url}`);
                const startTime = Date.now();

                try {
                    await Promise.all([
                        handleStatusPage(statuspage.id, client),
                        handleAlerts(statuspage.id, client)
                    ]);

                    // Reset failure count on success
                    if (statuspage.failureCount > 0) {
                        statuspage.failureCount = 0;
                        statuspage.lastFailure = null;
                        await statuspage.save();
                    }

                    await cache.set(cacheKey, 'true', { EX: LOCK_TTL });

                    const duration = Date.now() - startTime;
                    console.log(`[UpdateLoop] Completed ${statuspage.url} in ${duration}ms`);

                    return { updated: true, duration };
                } catch (error) {
                    console.error(`[UpdateLoop] Error updating ${statuspage.url}:`, error.message);

                    // Handle failure and potentially pause
                    const wasPaused = await StatuspagePauseManager.handleFailure(statuspage, error, client, models);

                    return {
                        failed: true,
                        paused: wasPaused,
                        error: error.message
                    };
                }
            }));

            const updated = results.filter(r => r.status === 'fulfilled' && r.value?.updated).length;
            const skipped = results.filter(r => r.status === 'fulfilled' && r.value?.skipped).length;
            const failed = results.filter(r => r.status === 'fulfilled' && r.value?.failed).length;
            const paused = results.filter(r => r.status === 'fulfilled' && r.value?.paused).length;

            console.log(`[UpdateLoop] Batch complete: ${updated} updated, ${skipped} skipped, ${failed} failed, ${paused} newly paused`);
        }
    } catch (error) {
        console.error(`[UpdateLoop] Error scheduling status page updates`, error);
    }
};

const startUpdateLoop = async (client) => {
    try {
        console.log(`[UpdateLoop] Loop iteration starting at ${new Date().toISOString()}`);
        await scheduleStatusPageUpdates(client);
        console.log(`[UpdateLoop] Loop iteration completed at ${new Date().toISOString()}`);
    } catch (error) {
        console.error("[UpdateLoop] Critical error in update loop:", error.message);
        console.error("[UpdateLoop] Stack:", error.stack);
    } finally {
        console.log(`[UpdateLoop] Scheduling next iteration in ${INTERVAL}ms`);
        setTimeout(() => startUpdateLoop(client), INTERVAL);
    }
};

startUpdateLoop(client);
