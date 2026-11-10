/**
 * Delivering to one channel without holding up any other.
 *
 * Every Discord request the handlers make for a subscription runs through `deliver()`, which
 * adds three things the handlers did not have:
 *
 * A DEADLINE. The handler stops waiting after DISCORD_DELIVERY_TIMEOUT_MS. It used to wait
 * for as long as Discord took, and a request can take for ever: @discordjs/rest answers a 429
 * by sleeping and retrying with no limit, and a channel nobody can post to returned to the
 * loop only when Discord stopped refusing it. Each subscription was delivered after the one
 * before it, and the next cycle started after the slowest page, so one such channel froze the
 * whole bot — in production for twenty to fifty minutes at a time.
 *
 * ONE AT A TIME PER SUBSCRIPTION. Stopping to wait does not stop the request; it may still
 * succeed, and the row that remembers the message is only written when it does. Starting
 * another delivery for the same subscription in the meantime would find no row and post the
 * same message a second time. So a subscription whose last delivery is still out is skipped
 * until it comes back. Status and alerts are separate lanes, because they are separate
 * messages and run concurrently by design.
 *
 * A BACKOFF PER SUBSCRIPTION AND LANE. A channel that refused the bot (50013), rate limited it
 * or did not answer is not asked again on the next cycle but after a growing pause. Each refused
 * request counts towards the 10,000 per 10 minutes at which Discord bans the bot's IP, and a
 * channel that refused at 12:00:00 will refuse at 12:00:15 too. The first success clears it,
 * and so does any /livck interaction in that guild (see `forgetGuild`), so an admin who fixes
 * a permission does not wait out the ladder.
 *
 * Per lane, because a lane can succeed without sending anything: an unchanged status embed
 * is a few database reads and no request at all. With one backoff per subscription that
 * "success" wiped the ladder the alert lane had just climbed, every cycle, and a channel
 * refusing every alert stayed at the first step — asked every thirty seconds, for ever.
 *
 * Held in memory. A restart costs one more attempt per broken channel, which is cheaper than
 * a migration and a write on every failure.
 */

import logger from './logger.js';

const TIMEOUT_MS = () => Number(process.env.DISCORD_DELIVERY_TIMEOUT_MS || 10_000);
const BACKOFF_BASE_MS = () => Number(process.env.DELIVERY_BACKOFF_BASE_MS || 30_000);

/** Multiples of the base: 30s, 1m, 2m, 5m, 10m, then 10m for as long as it lasts. */
const LADDER = [1, 2, 4, 10, 20];

export class DeliveryTimeout extends Error {
    constructor(ms) {
        super(`no answer from Discord within ${ms}ms`);
        this.name = 'DeliveryTimeout';
        this.code = 'DELIVERY_TIMEOUT';
    }
}

/** `${subscriptionId}:${lane}` → the promise of the delivery still out */
const inFlight = new Map();
/** `${subscriptionId}:${lane}` → { level, until, guildId } */
const failures = new Map();
/** Deleted subscriptions leave their entry behind; this keeps that from adding up. */
const MAX_FAILURES = 10_000;

const backoffFor = (level) => BACKOFF_BASE_MS() * LADDER[Math.min(level, LADDER.length) - 1];

const recordFailure = (key, subscription) => {
    const level = (failures.get(key)?.level ?? 0) + 1;
    const wait = backoffFor(level);
    failures.delete(key);
    if (failures.size >= MAX_FAILURES) failures.delete(failures.keys().next().value);
    failures.set(key, { level, until: Date.now() + wait, guildId: subscription.guildId });
    return wait;
};

const recordSuccess = (key) => {
    failures.delete(key);
    // A delivery that timed out and then arrived after all: the line saying it failed no
    // longer holds, and the next real failure should be logged again.
    logger.resetOnce(`deliver:${key}`);
};

/**
 * Would a delivery in this lane run now, or be skipped?
 *
 * For work that should not even start when it cannot be delivered — the close-out asks the
 * STATUS PAGE about a vanished alert before it has anything to send, and doing that for a
 * channel that is sitting out its backoff is a request to the customer's page every cycle,
 * for nothing.
 *
 * @returns {'ready'|'busy'|'backoff'}
 */
export const deliveryState = (subscription, lane) => {
    const key = `${subscription.id}:${lane}`;
    if (inFlight.has(key)) return 'busy';
    const failure = failures.get(key);
    return failure && failure.until > Date.now() ? 'backoff' : 'ready';
};

/**
 * Run `fn` as the delivery of one subscription in one lane.
 *
 * @template T
 * @param {{id: number, guildId?: string}} subscription
 * @param {'status'|'alerts'} lane
 * @param {() => Promise<T>} fn
 * @returns {Promise<{status: 'done', value: T} | {status: 'busy'} | {status: 'backoff', until: number}>}
 * @throws whatever `fn` throws, or a DeliveryTimeout. `error.retryInMs` says when the
 *   subscription will be tried again.
 */
export const deliver = async (subscription, lane, fn) => {
    const key = `${subscription.id}:${lane}`;

    if (inFlight.has(key)) return { status: 'busy' };

    const failure = failures.get(key);
    if (failure && failure.until > Date.now()) return { status: 'backoff', until: failure.until };

    const work = Promise.resolve().then(fn);

    inFlight.set(key, work);
    // Only the SUCCESS is recorded here, because it may come late and must still clear the
    // backoff. A failure is counted once, below, where the caller learns about it — a request
    // that fails after its timeout already counted is the same failure, not a second one.
    work.then(
        () => recordSuccess(key),
        () => {},
    ).finally(() => {
        if (inFlight.get(key) === work) inFlight.delete(key);
    });

    const ms = TIMEOUT_MS();
    let timer;
    const deadline = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            reject(new DeliveryTimeout(ms));
        }, ms);
        timer.unref?.();
    });

    try {
        const value = await Promise.race([work, deadline]);
        return { status: 'done', value };
    } catch (error) {
        error.retryInMs = recordFailure(key, subscription);
        throw error;
    } finally {
        clearTimeout(timer);
    }
};

/**
 * Clear the backoff of every subscription in a guild.
 *
 * Called on any /livck interaction there: whoever is using the command is in a position to
 * have just fixed the channel, and the immediate refresh that follows should be allowed to
 * prove it.
 */
export const forgetGuild = (guildId) => {
    if (!guildId) return;
    for (const [id, failure] of failures) {
        if (failure.guildId === guildId) failures.delete(id);
    }
};

/**
 * Run `fn` for every item with at most `limit` running at once.
 *
 * Subscriptions are delivered concurrently so one slow channel no longer holds up the next,
 * but not all at once: Discord allows the bot 50 requests per second in total, and a page with
 * three hundred subscriptions would otherwise queue three hundred requests in one burst.
 */
export const forEachLimited = async (items, limit, fn) => {
    const queue = [...items];
    const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
        while (queue.length > 0) {
            await fn(queue.shift());
        }
    });
    await Promise.all(workers);
};

export const DELIVERY_CONCURRENCY = Number(process.env.DELIVERY_CONCURRENCY || 10);

/**
 * One line for a failed delivery, repeated only when the message changes.
 *
 * Per lane: status and alerts used to share the key, so a success in one cleared the other's
 * and the same failure was logged again on every cycle.
 */
export const logDeliveryFailure = (scope, lane, subscription, error) => {
    const key = `deliver:${subscription.id}:${lane}`;

    // A timeout is not a failure yet. A long thread has to wait for Discord's five messages
    // per five seconds per channel and runs past the deadline by design; it finishes in the
    // background, and if it does, recordSuccess clears this line again.
    if (error instanceof DeliveryTimeout) {
        logger.once(
            key, 'warn',
            `[${scope}] Channel ${subscription.channelId} has not answered within ` +
            `${Math.round(TIMEOUT_MS() / 1000)}s; still waiting for it, without holding up anything else`
        );
        return;
    }

    const retry = error.retryInMs ? `, next attempt in ${Math.round(error.retryInMs / 1000)}s` : '';
    logger.once(
        key, 'error',
        `[${scope}] Could not deliver to channel ${subscription.channelId} ` +
        `(${error.code ?? error.name}): ${error.message}${retry}`
    );
};

export const logDeliverySuccess = (lane, subscription) => {
    logger.resetOnce(`deliver:${subscription.id}:${lane}`);
};

/** For tests. */
export const resetDelivery = () => {
    inFlight.clear();
    failures.clear();
};

export default { deliver, deliveryState, forgetGuild, forEachLimited, resetDelivery, DeliveryTimeout, DELIVERY_CONCURRENCY };
