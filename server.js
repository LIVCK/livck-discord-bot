import dotenv from 'dotenv';
import { Op } from 'sequelize';
import models from './models/index.js';
import bot from './discord/bot.js';
import { handleStatusPage } from "./handlers/handleStatuspage.js";
import { handleAlerts } from "./handlers/handleAlerts.js";
import cache from './database/redis.js';
import StatuspagePauseManager from './services/statuspagePauseManager.js';
import logger from './util/logger.js';

dotenv.config();

const client = await bot(models)

const BATCH_SIZE = 100;
const LOCK_TTL = 20;
const INTERVAL = 15 * 1000;

/**
 * Columns the loop needs.
 *
 * `failureCount`, `lastFailure`, `backoffLevel` and `nextAttemptAt` are load-bearing: the
 * previous version selected only four columns, which left the backoff counters `undefined`
 * on the instance. `undefined + 1` is `NaN`, `NaN >= threshold` is false, and the pause could
 * therefore never trigger. Selecting them is what makes the pause manager work at all.
 */
const LOOP_ATTRIBUTES = [
    'id', 'url', 'name',
    'paused', 'pauseReason',
    'failureCount', 'lastFailure',
    'backoffLevel', 'nextAttemptAt',
];

const processStatuspage = async (statuspage) => {
    const cacheKey = `dc-bot:statuspage:${statuspage.id}`;

    if (await cache.get(cacheKey)) {
        return { skipped: true };
    }

    const startTime = Date.now();

    try {
        await Promise.all([
            handleStatusPage(statuspage.id, client),
            handleAlerts(statuspage.id, client),
        ]);

        await StatuspagePauseManager.handleSuccess(statuspage, client, models);
        await cache.set(cacheKey, 'true', { EX: LOCK_TTL });

        const duration = Date.now() - startTime;
        logger.debug(`[UpdateLoop] ${statuspage.url} completed in ${duration}ms`);

        return { updated: true, duration };
    } catch (error) {
        // One line, no stack for the routine failure kinds, and repeats of the same message
        // for the same page are suppressed until the message changes.
        logger.failure('[UpdateLoop]', statuspage.url, error, `fetch:${statuspage.id}`);

        const result = await StatuspagePauseManager.handleFailure(statuspage, error, client, models);

        return { failed: true, paused: result.notified, level: result.level };
    }
};

const scheduleStatusPageUpdates = async () => {
    const now = new Date();

    // Backoff is enforced in the QUERY: a page waiting out its penalty is never loaded, so a
    // few hundred unreachable pages cost nothing per cycle.
    const due = await models.Statuspage.findAll({
        attributes: LOOP_ATTRIBUTES,
        where: {
            [Op.or]: [
                { nextAttemptAt: null },
                { nextAttemptAt: { [Op.lte]: now } },
            ],
        },
    });

    if (due.length === 0) {
        logger.debug('[UpdateLoop] Nothing due');
        return;
    }

    let updated = 0;
    let skipped = 0;
    let failed = 0;
    let announced = 0;

    for (let i = 0; i < due.length; i += BATCH_SIZE) {
        const batch = due.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(batch.map(processStatuspage));

        for (const result of results) {
            if (result.status === 'rejected') {
                // processStatuspage handles its own errors; anything escaping is a bug here.
                logger.error('[UpdateLoop] Unhandled error while processing a statuspage:', result.reason);
                failed += 1;
                continue;
            }
            if (result.value?.updated) updated += 1;
            if (result.value?.skipped) skipped += 1;
            if (result.value?.failed) failed += 1;
            if (result.value?.paused) announced += 1;
        }
    }

    // One summary line per cycle instead of several lines per statuspage.
    logger.info(
        `[UpdateLoop] ${due.length} due · ${updated} updated · ${skipped} cached · ${failed} failed${announced > 0 ? ` · ${announced} paused` : ''}`
    );
};

const startUpdateLoop = async () => {
    try {
        await scheduleStatusPageUpdates();
    } catch (error) {
        logger.error('[UpdateLoop] Critical error in update loop:', error);
    } finally {
        setTimeout(startUpdateLoop, INTERVAL);
    }
};

startUpdateLoop();
