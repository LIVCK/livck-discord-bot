/**
 * A brake on removing subscriptions.
 *
 * A channel that answers 10003 (Unknown Channel) or 50001 (Missing Access) is treated as gone
 * for good, and the subscription is deleted. That is right for the case it was written for —
 * somebody deleted the channel — and it is a customer's configuration, gone for good, with no
 * undo and no record of what it was.
 *
 * It is also exactly what a bot sees for EVERY channel when it is holding the wrong token.
 * Point a test bot at the production database and the first cycles delete every subscription
 * in it, one 10003 at a time, each one looking like an ordinary tidy-up in the log. The same
 * shape appears if Discord has an incident and answers 10003 for channels that are fine.
 *
 * So deletions are counted per process, and past a threshold they stop. A handful of removed
 * channels a day is normal life. Dozens in one run is not a tidy-up, it is a symptom — and the
 * right response to a symptom nobody has diagnosed is to stop touching the data and say so.
 *
 * Deliberately in memory: a restart clears it, which is what an operator who has fixed the
 * cause will do anyway.
 */

import logger from './logger.js';

/** Deletions allowed before the brake engages. */
export const REAP_LIMIT = Number(process.env.SUBSCRIPTION_REAP_LIMIT || 25);

let reaped = 0;
let announced = false;

/**
 * May this subscription be deleted?
 *
 * @returns {boolean} false once the limit is reached — the caller should skip the channel and
 *   leave the row alone.
 */
export const mayReap = () => {
    if (reaped < REAP_LIMIT) return true;

    if (!announced) {
        announced = true;
        logger.error(
            `[Reaper] Refusing to remove any more subscriptions: ${reaped} were removed in this ` +
            'run, which is far more than a deleted channel here and there. Check that the bot ' +
            'is holding the right token for this database. Nothing further will be deleted ' +
            'until the process is restarted.'
        );
    }

    return false;
};

/** Record a deletion that actually happened. */
export const recordReap = () => { reaped += 1; };

/** How many have been removed in this run. */
export const reapCount = () => reaped;

/** Reset. For tests, and for nothing else. */
export const resetReaper = () => { reaped = 0; announced = false; };

export default { mayReap, recordReap, reapCount, resetReaper, REAP_LIMIT };
