/**
 * One render at a time, per status page, inside this process.
 *
 * `handleStatusPage` looks for the Message row it should edit and creates one when there is
 * none. That is a check-then-act, and it is safe only while nothing else renders the same page
 * at the same moment.
 *
 * Something else does. Seven places in `/livck` call `handleStatusPage` fire-and-forget so the
 * channel updates immediately — on subscribe, on a layout change, on a language change, on
 * every custom-link edit — and none of them takes the update loop's Redis claim. Subscribe is
 * the worst of them: it runs at the exact moment the loop is most likely to be working on that
 * page anyway, because the page was just added.
 *
 * Both then find no row, and both post. The channel ends up with two identical status
 * messages, and the database with two rows carrying the same hash — and since the handler
 * only ever reads the FIRST one back, the second is orphaned on the spot: never edited again,
 * never deleted, still showing the old layout after the user switches. Observed in production
 * within minutes of adding a subscription.
 *
 * The Redis claim does not help here, because the loop holds it while calling this. What is
 * needed is narrower: two calls for the same page, in this process, run one after the other.
 */

/** statuspageId → the tail of the queue for that page. */
const queues = new Map();

/**
 * Run `fn` once every earlier call for the same page has finished.
 *
 * @param {number|string} pageId
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export const withPageLock = (pageId, fn) => {
    const key = String(pageId);
    const previous = queues.get(key) ?? Promise.resolve();

    // Chained off the settled outcome: one call failing must not cancel the next.
    const next = previous.then(fn, fn);

    // Drop the entry once this is the last one, so the map does not keep an entry per page for
    // the life of the process.
    //
    // The comparison is against the promise actually STORED, which is the cleanup one and not
    // `next` — an earlier version compared against `next` while storing something else, so the
    // condition was never true and nothing was ever deleted. The map held one settled promise
    // per status page for ever, silently, and its own comment said otherwise.
    let stored;
    const drop = () => { if (queues.get(key) === stored) queues.delete(key); };
    stored = next.then(drop, drop);
    queues.set(key, stored);

    return next;
};

/** How many pages currently have work queued. For tests. */
export const pendingPages = () => queues.size;

export default { withPageLock, pendingPages };
