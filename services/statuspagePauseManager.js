/**
 * Backoff and pause handling for unreachable status pages.
 *
 * WHY THIS WAS REWRITTEN
 *
 * The previous version could not fire, for two independent reasons:
 *
 *   1. Errors never reached it. `LIVCK.get()` returned `{data: []}` instead of throwing and
 *      the handlers swallowed what was left, so the `catch` in server.js that calls
 *      `handleFailure` almost never ran. A dead domain looked like "zero categories" forever.
 *
 *   2. The counter was NaN. server.js loaded only `['id','url','paused','pauseReason']`, so
 *      `statuspage.failureCount` was `undefined`; `undefined + 1` is `NaN` and `NaN >= 3` is
 *      false. The threshold could never be reached.
 *
 * Both are fixed at the source (api/livck.js throws, server.js loads the columns). What
 * changed here is the model: pausing is no longer a binary dead end that needs a human with
 * `/livck resume`. A failing page climbs a backoff ladder, subscribers are told once when it
 * has been failing long enough to matter, and the page comes back on its own as soon as it
 * answers again.
 */

import { hashPayload } from '../util/messageSync.js';
import { classifyError, FAILURE_KINDS } from '../util/errors.js';
import logger from '../util/logger.js';
import translation, { withLocale } from '../util/Translation.js';
import cache from '../database/redis.js';

/**
 * Wait before the next attempt, indexed by `backoffLevel - 1`.
 * A page that keeps failing settles at six hours, which is 4 requests a day instead of 5760.
 */
export const BACKOFF_LADDER_MS = [
    30 * 1000,
    60 * 1000,
    5 * 60 * 1000,
    15 * 60 * 1000,
    60 * 60 * 1000,
    6 * 60 * 60 * 1000,
];

/**
 * Level at which subscribers are told. Reached after roughly 21 minutes of continuous
 * failure (30s + 1m + 5m + 15m), which is long enough to ride out a deploy or a blip and
 * short enough to be useful.
 */
export const NOTIFY_AT_LEVEL = 4;

/** What separates the page name from the staleness note in a footer. */
const FOOTER_SEPARATOR = ' · ';

/** Cooldown between two manual `/livck resume` attempts for the same page. */
const RESUME_COOLDOWN_MS = 60 * 1000;

/** Delay for a level, clamped to the top rung. */
export const backoffDelay = (level) =>
    BACKOFF_LADDER_MS[Math.min(Math.max(level, 1), BACKOFF_LADDER_MS.length) - 1];

export class StatuspagePauseManager {
    /**
     * Record a failed cycle: advance the backoff, store the reason, and notify subscribers
     * once when the page crosses the notification threshold.
     *
     * @param {object} statuspage - Statuspage row, loaded WITH the backoff columns
     * @param {Error} error
     * @param {object} client - Discord client (optional; no notification without it)
     * @param {object} models
     * @returns {Promise<{level: number, kind: string, nextAttemptAt: Date, paused: boolean, marked: boolean}>}
     */
    static async handleFailure(statuspage, error, client, models) {
        const { kind } = classifyError(error);
        const now = new Date();

        const level = Math.min((statuspage.backoffLevel || 0) + 1, BACKOFF_LADDER_MS.length);
        const nextAttemptAt = new Date(now.getTime() + backoffDelay(level));

        const crossedThreshold = level >= NOTIFY_AT_LEVEL && !statuspage.paused;

        statuspage.backoffLevel = level;
        statuspage.nextAttemptAt = nextAttemptAt;
        statuspage.failureCount = (statuspage.failureCount || 0) + 1;
        statuspage.lastFailure = now;
        statuspage.pauseReason = kind;
        if (crossedThreshold) statuspage.paused = true;

        await statuspage.save();

        // Routine ladder movement is `debug`: the line carries the level and the next attempt
        // time, so it differs every cycle and could never be deduped — its volume is bounded
        // by the backoff itself, not by the logger. The update loop already emits one
        // deduplicated warning naming the actual failure.
        logger.debug(
            `[PauseManager] ${statuspage.url}: ${kind}, backoff level ${level}, next attempt ${nextAttemptAt.toISOString()}`
        );

        let marked = false;
        if (crossedThreshold) {
            // Crossing the threshold happens once per outage, so it is worth a warning.
            logger.warn(`[PauseManager] ${statuspage.url} paused after ${statuspage.failureCount} failures (${kind})`);

            if (client && models) {
                marked = await this.#markStale(statuspage, kind, client, models);
            }
        }

        return { level, kind, nextAttemptAt, paused: Boolean(statuspage.paused), marked };
    }

    /**
     * Record a successful cycle. Clears the backoff. Nothing is announced either way — if
     * paused, tells the subscribers it is back.
     *
     * @returns {Promise<boolean>} true when the page recovered from a paused state
     */
    static async handleSuccess(statuspage, client, models) {
        const wasPaused = Boolean(statuspage.paused);
        const wasFailing = (statuspage.backoffLevel || 0) > 0 || (statuspage.failureCount || 0) > 0;

        if (!wasPaused && !wasFailing) return false;

        statuspage.paused = false;
        statuspage.pauseReason = null;
        statuspage.failureCount = 0;
        statuspage.lastFailure = null;
        statuspage.backoffLevel = 0;
        statuspage.nextAttemptAt = null;
        await statuspage.save();

        // Clear the suppression state, or the NEXT outage with the same cause would be
        // deduped against the message from this one and never appear in the log.
        logger.resetOnce(`fetch:${statuspage.id}`);
        logger.info(`[PauseManager] ${statuspage.url} recovered`);

        // Nothing is announced on the way back either. The next render simply produces the
        // page's real content again, footer included, and the edit that carries it is the
        // only signal a reader needs.
        return wasPaused;
    }

    /** Should the update loop skip this page right now? */
    static shouldSkip(statuspage, now = Date.now()) {
        if (!statuspage.nextAttemptAt) return false;
        return new Date(statuspage.nextAttemptAt).getTime() > now;
    }

    /**
     * Mark the pages status messages as stale, quietly.
     *
     * NO SEPARATE MESSAGE. An outage used to post its own embed into every subscribed channel,
     * and a recovery posted another one — two notifications, per channel, per outage, for
     * something the reader did not ask to be told about. A status page going quiet is not
     * news; it is the absence of news, and it belongs in the message that is already there.
     *
     * So the existing status embed keeps its last known content and gains one line in its
     * FOOTER. It costs one edit per subscription at the moment the page crosses the pause
     * threshold — not one per cycle — and the next successful render rebuilds the footer
     * normally, which is what clears it. There is no "back online" message at all: the
     * content simply starts moving again.
     *
     * The stored hash is updated to the annotated payload on purpose. Leaving it would make
     * the recovery render look identical to what is stored, the edit would be skipped, and the
     * stale marker would sit there for ever.
     */
    static async #markStale(statuspage, kind, client, models) {
        let marked = 0;

        try {
            const subscriptions = await models.Subscription.findAll({
                where: { statuspageId: statuspage.id },
            });

            for (const subscription of subscriptions) {
                try {
                    const record = await models.Message.findOne({
                        where: { subscriptionId: subscription.id, category: 'STATUS' },
                    });
                    if (!record?.messageId) continue;

                    const channel = await client.channels.fetch(subscription.channelId);
                    if (!channel) continue;

                    const existing = await channel.messages.fetch(record.messageId);
                    const embed = existing?.embeds?.[0]?.toJSON?.();
                    if (!embed) continue;

                    const locale = subscription.locale || 'de';
                    const note = withLocale(locale, () => {
                        const reason = translation.trans(`messages.pause.reason.${kind}`)
                            || translation.trans(`messages.pause.reason.${FAILURE_KINDS.UNKNOWN}`);
                        return translation.trans('messages.pause.footer', { reason });
                    });

                    const base = (embed.footer?.text || statuspage.name || statuspage.url)
                        .split(FOOTER_SEPARATOR)[0];

                    const payload = {
                        embeds: [{ ...embed, footer: { ...embed.footer, text: `${base}${FOOTER_SEPARATOR}${note}` } }],
                        components: existing.components ?? [],
                    };

                    await channel.messages.edit(record.messageId, payload);
                    await models.Message.update(
                        { contentHash: hashPayload(payload) },
                        { where: { id: record.id } }
                    );
                    marked += 1;
                } catch (error) {
                    // A channel we can no longer reach is not worth a stack trace; the update
                    // loop removes such subscriptions on its own next pass.
                    logger.debug(
                        `[PauseManager] Could not mark channel ${subscription.channelId}: ${error.message}`
                    );
                }
            }
        } catch (error) {
            logger.error('[PauseManager] Error marking status messages stale:', error);
        }

        return marked > 0;
    }

    /**
     * Manual `/livck resume`: clear the backoff so the next loop iteration retries at once.
     *
     * No reachability probe here any more. The old version fetched the page twice before
     * agreeing to resume, which duplicated exactly what the next cycle does anyway — and
     * refused to resume a page that was momentarily slow, leaving the user stuck. The loop
     * is the single place that decides whether a page works.
     *
     * @returns {Promise<{success: boolean, message: string, rateLimited?: boolean, remainingSeconds?: number}>}
     */
    static async resume(statuspage) {
        if (!statuspage.paused && !statuspage.nextAttemptAt) {
            return { success: false, message: 'Statuspage is not paused' };
        }

        const rateLimitKey = `resume:${statuspage.id}`;
        const lastResume = await cache.get(rateLimitKey);
        if (lastResume) {
            const remainingSeconds = Math.max(
                1,
                Math.ceil((RESUME_COOLDOWN_MS - (Date.now() - parseInt(lastResume, 10))) / 1000)
            );
            return {
                success: false,
                message: `Please wait ${remainingSeconds} seconds before trying again`,
                rateLimited: true,
                remainingSeconds,
            };
        }

        statuspage.paused = false;
        statuspage.pauseReason = null;
        statuspage.failureCount = 0;
        statuspage.lastFailure = null;
        statuspage.backoffLevel = 0;
        statuspage.nextAttemptAt = null;
        await statuspage.save();

        await cache.set(rateLimitKey, Date.now().toString(), { EX: Math.ceil(RESUME_COOLDOWN_MS / 1000) });
        logger.resetOnce(`fetch:${statuspage.id}`);
        logger.info(`[PauseManager] ${statuspage.url} resumed manually`);

        return { success: true, message: 'Statuspage resumed — it will be retried on the next cycle' };
    }

    /** All paused statuspages a guild is subscribed to. */
    static async getPausedForGuild(models, guildId) {
        return models.Statuspage.findAll({
            where: { paused: true },
            include: [{
                model: models.Subscription,
                where: { guildId },
                required: true,
            }],
        });
    }
}

export default StatuspagePauseManager;
