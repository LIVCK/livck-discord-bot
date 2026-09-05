import { Op, literal } from 'sequelize';
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

/**
 * How long a page stays claimed, in seconds.
 *
 * Deliberately BELOW the 15s interval. It used to be 20, which meant the key written for one
 * cycle outlived the next one — so half of all cycles found the page still claimed and skipped
 * it, and a status page that documents a 15-second loop actually refreshed every 30. An
 * incident reached Discord up to twice as late as intended, and the wasted cycles still cost a
 * full query plus a Redis round trip per page.
 *
 * 12 leaves the claim covering the work of one cycle (a page that takes longer than this has
 * already blown the interval) while being gone before the next one starts.
 */
const LOCK_TTL = Number(process.env.REDIS_LOCK_TTL_SECONDS || 12);

/**
 * How long to wait on Redis before deciding it is not going to answer.
 *
 * Redis is not a correctness boundary for a single instance — the backoff and the content
 * hash are — so an unreachable Redis must degrade to unlocked polling, never to a stopped
 * bot. It stopped the bot before: the lock read was the first `await` of every page, and with
 * Redis down that promise never settled, so the cycle never finished and the timer that
 * schedules the next one never ran. Silent, indefinite, and invisible in the log.
 */
const LOCK_TIMEOUT_MS = Number(process.env.REDIS_LOCK_TIMEOUT_MS || 2000);

const withDeadline = (promise, ms, label) => Promise.race([
    promise,
    new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms).unref()),
]);

/**
 * Claim a status page for this cycle.
 *
 * `SET NX EX` in ONE round trip, BEFORE the work — the previous version read the key first
 * and wrote it only after the handlers had finished, which is a check-then-act with the whole
 * cycle in between. Two overlapping cycles therefore both saw no key, both ran, both found no
 * `Message` row and both POSTED: two status embeds in the customer's channel, two rows for
 * one subscription, and the second message frozen at its first content for ever because
 * `findOne` only ever returns the first row again. Overlap is not hypothetical — a redeploy
 * where the new process starts before the old one drains is enough.
 *
 * @returns {Promise<boolean>} true when this cycle owns the page
 */
const claim = async (statuspageId) => {
    const key = `dc-bot:statuspage:${statuspageId}`;

    try {
        const reply = await withDeadline(
            cache.set(key, '1', { NX: true, EX: LOCK_TTL }),
            LOCK_TIMEOUT_MS,
            'redis SET NX',
        );
        return reply === 'OK';
    } catch (error) {
        // One line for the whole outage, not one per page per cycle.
        logger.once(
            'redis:lock', 'warn',
            `[UpdateLoop] Redis unavailable (${error.message}); polling without the lock`
        );
        return true;
    }
};

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
    // Claimed before any work, and held for LOCK_TTL — which also keeps the page out of the
    // cycle right after, the way the old post-hoc marker did.
    if (!await claim(statuspage.id)) {
        return { skipped: true };
    }

    const startTime = Date.now();

    try {
        await Promise.all([
            handleStatusPage(statuspage.id, client),
            handleAlerts(statuspage.id, client),
        ]);

        await StatuspagePauseManager.handleSuccess(statuspage, client, models);

        const duration = Date.now() - startTime;
        logger.debug(`[UpdateLoop] ${statuspage.url} completed in ${duration}ms`);

        return { updated: true, duration };
    } catch (error) {
        // One line, no stack for the routine failure kinds, and repeats of the same message
        // for the same page are suppressed until the message changes.
        logger.failure('[UpdateLoop]', statuspage.url, error, `fetch:${statuspage.id}`);

        const result = await StatuspagePauseManager.handleFailure(statuspage, error, client, models);

        return { failed: true, marked: result.marked, level: result.level };
    }
};

/**
 * Process every status page that is due.
 *
 * @returns {Promise<{due: number, updated: number, skipped: number, failed: number, marked: number}>}
 */
export const runCycle = async (client) => {
    const now = new Date();

    // Two filters, both in the QUERY, because everything they exclude would otherwise cost a
    // request to a customer's status page every 15 seconds:
    //
    //   1. Nobody is listening. Nothing ever deletes a Statuspage — not `/livck unsubscribe`,
    //      not the automatic removal of a subscription whose channel is gone — so every page
    //      the bot has ever been pointed at stays in the table and was polled for ever, with
    //      no subscriber left to receive the result. Filtering beats deleting: the row keeps
    //      its detected `kind` and Cloud page id for whenever someone subscribes again, and
    //      the pages that have already piled up simply go quiet without a migration.
    //
    //   2. It is serving a backoff penalty. A few hundred unreachable pages then cost nothing
    //      per cycle instead of one failing request each.
    //
    // A subquery rather than a join: an INNER JOIN would return the page once per
    // subscription, and this must yield each page exactly once.
    const due = await models.Statuspage.findAll({
        attributes: LOOP_ATTRIBUTES,
        where: {
            id: { [Op.in]: literal('(SELECT DISTINCT statuspageId FROM Subscriptions)') },
            [Op.or]: [
                { nextAttemptAt: null },
                { nextAttemptAt: { [Op.lte]: now } },
            ],
        },
    });

    const summary = { due: due.length, updated: 0, skipped: 0, failed: 0, marked: 0 };

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
            if (result.value?.marked) summary.marked += 1;
        }
    }

    // One summary line per cycle instead of several lines per statuspage.
    logger.info(
        `[UpdateLoop] ${summary.due} due · ${summary.updated} updated · ${summary.skipped} cached · ` +
        `${summary.failed} failed${summary.marked > 0 ? ` · ${summary.marked} marked stale` : ''}`
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
