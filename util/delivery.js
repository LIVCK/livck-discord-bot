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
 * or did not answer is not asked again on the next cycle but after a growing pause. A channel
 * the bot can no longer see at all (50001) climbs a longer ladder, up to six hours: that is
 * rarely fixed within minutes and sometimes never, and asking every ten minutes for weeks is
 * thousands of invalid requests per channel for nothing. Each refused
 * request counts towards the 10,000 per 10 minutes at which Discord bans the bot's IP, and a
 * channel that refused at 12:00:00 will refuse at 12:00:15 too. The first success clears it,
 * and so does any /livck interaction in that guild or any change to a channel or a role there
 * (see `forgetGuild`), so an admin who fixes a permission does not wait out the ladder.
 *
 * Per lane, because a lane can succeed without sending anything: an unchanged status embed
 * is a few database reads and no request at all. With one backoff per subscription that
 * "success" wiped the ladder the alert lane had just climbed, every cycle, and a channel
 * refusing every alert stayed at the first step — asked every thirty seconds, for ever.
 *
 * A LIMITED NUMBER OF SLOTS, shared by every page. Discord allows the bot 50 requests per
 * second in total, and discord.js holds whatever goes over that in a queue of its own — where
 * the deadline above kept running. A burst (the first cycle after a restart, when every
 * heartbeat is due at once) sent a few hundred deliveries into that queue together, every one
 * of them overran its deadline, and every channel was logged as not answering. An incident
 * alert, meanwhile, stood behind all of them. Now at most DISCORD_DELIVERY_SLOTS deliveries
 * are with discord.js at a time, the deadline starts when a delivery gets its slot, and an
 * alert waiting for one goes before every status edit.
 *
 * Held in memory. A restart costs one more attempt per broken channel, which is cheaper than
 * a migration and a write on every failure.
 */

import logger from './logger.js';

const TIMEOUT_MS = () => Number(process.env.DISCORD_DELIVERY_TIMEOUT_MS || 10_000);
const BACKOFF_BASE_MS = () => Number(process.env.DELIVERY_BACKOFF_BASE_MS || 30_000);

/**
 * Deliveries with discord.js at once. Most are one request, a new alert thread a few, and
 * what the slots hold must clear Discord's 50 per second well inside the deadline: 25 is at
 * most a second or two of queue, against 10s.
 */
const SLOTS = () => Math.max(1, Number(process.env.DISCORD_DELIVERY_SLOTS || 25));

/** Multiples of the base: 30s, 1m, 2m, 5m, 10m, then 10m for as long as it lasts. */
const LADDER = [1, 2, 4, 10, 20];

/**
 * For 50001, the bot not seeing the channel any more: 1m, 5m, 15m, 1h, 3h, then 6h. The first
 * steps are short because the usual cause is an admin rearranging permissions right now; the
 * last is long because a channel that stays hidden for a day is likely to stay hidden.
 */
const NO_ACCESS_LADDER = [2, 10, 30, 120, 360, 720];
const MISSING_ACCESS = 50001;

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

let busySlots = 0;
/** Waiting for a slot, alerts first: an incident should not stand behind a heartbeat. */
const waiting = { alerts: [], status: [] };
/** Bumped by resetDelivery, so work from before it does not release a slot of after it. */
let generation = 0;
/**
 * Set once the process starts shutting down. A page that overran its deadline is still running
 * when the shutdown drains what is in flight, and it can reach `deliver()` after that snapshot
 * was taken — a message posted as the database closes, without the row that remembers it.
 */
let closing = false;

/** @returns {Promise<boolean>} false when the wait was cancelled by a shutdown */
const acquireSlot = (lane) => {
    if (busySlots < SLOTS()) {
        busySlots += 1;
        return Promise.resolve(true);
    }
    return new Promise((resolve) => (waiting[lane] ?? waiting.status).push(resolve));
};

const releaseSlot = () => {
    const next = waiting.alerts.shift() ?? waiting.status.shift();
    // The slot passes straight on, so nothing can take it in between.
    if (next) next(true);
    else busySlots -= 1;
};

/** How many deliveries are waiting for a slot right now. */
export const queuedDeliveries = () => waiting.alerts.length + waiting.status.length;

/** How many slots are taken right now. For tests: the count must come back to zero. */
export const busyDeliverySlots = () => busySlots;

const backoffFor = (level, ladder = LADDER) => BACKOFF_BASE_MS() * ladder[Math.min(level, ladder.length) - 1];

const recordFailure = (key, subscription, error) => {
    const level = (failures.get(key)?.level ?? 0) + 1;
    const wait = backoffFor(level, error?.code === MISSING_ACCESS ? NO_ACCESS_LADDER : LADDER);
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
 * @returns {Promise<{status: 'done', value: T} | {status: 'busy'} | {status: 'backoff', until: number} | {status: 'cancelled'}>}
 * @throws whatever `fn` throws, or a DeliveryTimeout. `error.retryInMs` says when the
 *   subscription will be tried again.
 */
export const deliver = async (subscription, lane, fn) => {
    const key = `${subscription.id}:${lane}`;

    if (closing) return { status: 'cancelled' };
    if (inFlight.has(key)) return { status: 'busy' };

    const failure = failures.get(key);
    if (failure && failure.until > Date.now()) return { status: 'backoff', until: failure.until };

    // In flight from the moment it is queued: a cycle that comes round while this one is still
    // waiting for a slot must find it busy, not queue the same message a second time.
    let settle;
    const tracked = new Promise((resolve) => { settle = resolve; });
    inFlight.set(key, tracked);
    const finished = () => {
        settle();
        if (inFlight.get(key) === tracked) inFlight.delete(key);
    };

    if (!await acquireSlot(lane)) {
        finished();
        return { status: 'cancelled' };
    }

    const mine = generation;
    let holding = true;
    const giveBack = () => {
        if (!holding) return;
        holding = false;
        if (mine === generation) releaseSlot();
    };

    const work = Promise.resolve().then(fn);

    // Only the SUCCESS is recorded here, because it may come late and must still clear the
    // backoff. A failure is counted once, below, where the caller learns about it — a request
    // that fails after its timeout already counted is the same failure, not a second one.
    work.then(
        () => recordSuccess(key),
        () => {},
    ).finally(() => {
        giveBack();
        finished();
    });

    const ms = TIMEOUT_MS();
    let timer;
    const deadline = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            // The request carries on, but it no longer holds a slot: a channel that never
            // answers must not take the place of one that would.
            giveBack();
            reject(new DeliveryTimeout(ms));
        }, ms);
        timer.unref?.();
    });

    try {
        const value = await Promise.race([work, deadline]);
        return { status: 'done', value };
    } catch (error) {
        error.retryInMs = recordFailure(key, subscription, error);
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
 * prove it. And on any change to a channel or a role in the guild (discord/bot.js), which is
 * what fixing a permission is — the next cycle tries again instead of hours later.
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
 * What went wrong, in words. A RateLimitError from @discordjs/rest has no message at all, so
 * the line used to end in "): , next attempt in 60s".
 */
const describe = (error) => {
    if (error.message) return error.message;
    if (error.timeToReset !== undefined || error.retryAfter !== undefined) {
        const wait = Math.round(Number(error.retryAfter ?? error.timeToReset) / 100) / 10;
        const scope = error.global ? 'global' : (error.scope ?? 'route');
        return `rate limited by Discord (${scope}, ${wait}s)`;
    }
    return 'no reason given';
};

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
        `(${error.code ?? error.name}): ${describe(error)}${retry}`
    );
};

export const logDeliverySuccess = (lane, subscription) => {
    logger.resetOnce(`deliver:${subscription.id}:${lane}`);
};

/**
 * Resolves once every delivery still out has settled — including ones that outlived their
 * deadline. For shutdown: see util/shutdown.js. What is still waiting for a slot is not
 * started any more: it would reach Discord just as the database closes, which is the
 * post-without-a-row this exists to prevent. The next process sends it. Nor does anything
 * that asks for a delivery after this was called.
 */
export const drainDeliveries = () => {
    closing = true;
    for (const lane of Object.keys(waiting)) {
        for (const resolve of waiting[lane].splice(0)) resolve(false);
    }
    return Promise.allSettled([...inFlight.values()]);
};

/** For tests. */
export const resetDelivery = () => {
    for (const lane of Object.keys(waiting)) {
        for (const resolve of waiting[lane].splice(0)) resolve(false);
    }
    generation += 1;
    busySlots = 0;
    closing = false;
    inFlight.clear();
    failures.clear();
};

export default { deliver, deliveryState, drainDeliveries, busyDeliverySlots, forgetGuild, forEachLimited, queuedDeliveries, resetDelivery, DeliveryTimeout, DELIVERY_CONCURRENCY };
