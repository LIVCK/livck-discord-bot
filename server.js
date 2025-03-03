import dotenv from 'dotenv';
import models from './models/index.js';
import bot from './discord/bot.js';
import { handleStatusPage } from "./handlers/handleStatuspage.js";
import { handleAlerts } from "./handlers/handleAlerts.js";
import cache from './database/redis.js';

dotenv.config();

const client = await bot(models)

const BATCH_SIZE = 100;
const LOCK_TTL = 5;
const INTERVAL = 15 * 1000;

const scheduleStatusPageUpdates = async (client) => {
    try {
        const statuspages = await models.Statuspage.findAll({
            attributes: ['id', 'url'],
            raw: true
        });

        for (let i = 0; i < statuspages.length; i += BATCH_SIZE) {
            const batch = statuspages.slice(i, i + BATCH_SIZE);
            console.log(`Processing batch ${i / BATCH_SIZE + 1}`);

            await Promise.allSettled(batch.map(async (statuspage) => {
                let cacheKey = `dc-bot:statuspage:${statuspage.id}`;
                let cacheValue = await cache.get(cacheKey) || false;
                if (cacheValue) {
                    return;
                }

                await Promise.all([
                    handleStatusPage(statuspage.id, client),
                    handleAlerts(statuspage.id, client)
                ]);

                await cache.set(cacheKey, 'true', 'EX', LOCK_TTL);
            }));
        }
    } catch (error) {
        console.error(`Error scheduling status page updates`, error);
    }
};

const startUpdateLoop = async (client) => {
    while (true) {
        const startTime = Date.now();

        try {
            await scheduleStatusPageUpdates(client);
        } catch (error) {
            console.error("Error in update loop", error);
        }

        const elapsed = Date.now() - startTime;
        const delay = Math.max(INTERVAL - elapsed, 0);

        await new Promise(resolve => setTimeout(resolve, delay));
    }
    // try {
    //     await scheduleStatusPageUpdates(client);
    // } catch (error) {
    //     console.error("Error in update loop", error);
    // } finally {
    //     setTimeout(() => startUpdateLoop(client), INTERVAL);
    // }
};

startUpdateLoop(client);
