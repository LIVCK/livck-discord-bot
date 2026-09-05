import { Op } from 'sequelize';
import models from '../models/index.js';
import { handleStatusPage } from '../handlers/handleStatuspage.js';
import { handleAlerts } from '../handlers/handleAlerts.js';
import cache from '../database/redis.js';
import StatuspagePauseManager from './statuspagePauseManager.js';
import logger from '../util/logger.js';

/**
 * The update cycle.
 *
 * Extracted from server.js so it can be exercised without a Discord token: the loop is where
 * the backoff, the pause notifications and the per-page locking actually meet, and none of
 * that was reachable from a test while it lived inside the process entry point. server.js is
 * now only wiring.
 */

const BATCH_SIZE = 100;

/** How long a processed page is skipped, so two overlapping cycles cannot both do the work. */
const LOCK_TTL = 20;

export const INTERVAL = 15 * 1000;

/**
 * Columns the loop needs.
 *
 * `failureCount`, `lastFailure`, `backoffLevel` and `nextAttemptAt` are load-bearing: an
 * earlier version selected only four columns, which left the backoff counters `undefined` on
 * the instance. `undefined + 1` is `NaN`, `NaN >= threshold` is false, and the pause could
 * therefore never trigger. Selecting them is what makes the pause manager work at all.
 */
const LOOP_ATTRIBUTES = [
    'id', 'url', 'name',
    'paused', 'pauseReason',
    'failureCount', 'lastFailure',
    'backoffLevel', 'nextAttemptAt',
    'kind', 'externalId',
];

/**
 * Run one status page through both handlers.
 *
 * @returns {Promise<{skipped?: boolean, updated?: boolean, failed?: boolean, paused?: boolean, duration?: number, level?: number}>}
 */
export const processStatuspage = async (statuspage, client) => {
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

/**
 * Process every status page that is due.
 *
 * @returns {Promise<{due: number, updated: number, skipped: number, failed: number, announced: number}>}
 */
export const runCycle = async (client) => {
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

    const summary = { due: due.length, updated: 0, skipped: 0, failed: 0, announced: 0 };

    if (due.length === 0) {
        logger.debug('[UpdateLoop] Nothing due');
        return summary;
    }

    for (let i = 0; i < due.length; i += BATCH_SIZE) {
        const batch = due.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(batch.map((page) => processStatuspage(page, client)));

        for (const result of results) {
            if (result.status === 'rejected') {
                // processStatuspage handles its own errors; anything escaping is a bug here.
                logger.error('[UpdateLoop] Unhandled error while processing a statuspage:', result.reason);
                summary.failed += 1;
                continue;
            }
            if (result.value?.updated) summary.updated += 1;
            if (result.value?.skipped) summary.skipped += 1;
            if (result.value?.failed) summary.failed += 1;
            if (result.value?.paused) summary.announced += 1;
        }
    }

    // One summary line per cycle instead of several lines per statuspage.
    logger.info(
        `[UpdateLoop] ${summary.due} due · ${summary.updated} updated · ${summary.skipped} cached · ` +
        `${summary.failed} failed${summary.announced > 0 ? ` · ${summary.announced} paused` : ''}`
    );

    return summary;
};

/** Run forever, one cycle every INTERVAL. A cycle never brings the process down. */
export const startUpdateLoop = async (client) => {
    try {
        await runCycle(client);
    } catch (error) {
        logger.error('[UpdateLoop] Critical error in update loop:', error);
    } finally {
        setTimeout(() => startUpdateLoop(client), INTERVAL);
    }
};

export default { runCycle, processStatuspage, startUpdateLoop, INTERVAL };
