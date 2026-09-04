import { detectSource } from '../api/detect.js';
import { SOURCE } from '../dto/statuspage.js';
import { FAILURE_KINDS } from '../util/errors.js';
import logger from '../util/logger.js';
import * as cloudProvider from './cloud.js';
import * as selfHostedProvider from './selfHosted.js';

/**
 * Picks the right adapter for a status page and hands back one snapshot.
 *
 * Everything above this line (handlers, layouts) is unaware of which product a page runs.
 *
 * DETECTION IS LAZY AND STICKY
 *
 * A page's kind is probed once and then stored on the row, so the ordinary cycle costs no
 * extra request. Rows that existed before this feature have `kind = null` and are detected on
 * their first cycle after deploy — which is why no backfill migration is needed.
 *
 * ONE FETCH PER CYCLE, NOT TWO
 *
 * handleStatusPage and handleAlerts run concurrently for the same page, and for a Cloud page
 * both need the SAME `/full` payload. Without the in-flight dedupe below, enabling the Cloud
 * would double the request count against an edge budget of 300/minute shared across every
 * Cloud page the bot watches.
 */

/** How long a fetched snapshot may be reused. Shorter than the 15s update interval. */
const SNAPSHOT_TTL_MS = Number(process.env.SNAPSHOT_TTL_MS || 10_000);

/** Bounded so a large fleet cannot grow this without limit. */
const MAX_CACHE_ENTRIES = 5000;

/** key → { at, promise } */
const inFlight = new Map();

const cacheKey = (statuspage, token, locale) => `${statuspage.url}::${token || ''}::${locale}`;

const rememberSnapshot = (key, promise) => {
    if (inFlight.size >= MAX_CACHE_ENTRIES) {
        const oldest = inFlight.keys().next().value;
        if (oldest !== undefined) inFlight.delete(oldest);
    }
    inFlight.set(key, { at: Date.now(), promise });

    // A rejected fetch must not be cached: the next cycle has to retry, and the backoff in
    // services/statuspagePauseManager.js is what decides when.
    promise.catch(() => inFlight.delete(key));
};

/** Forget every memoized snapshot. Exposed for tests. */
export const clearSnapshotCache = () => inFlight.clear();

/**
 * Determine which product a page runs, probing once and remembering the answer.
 *
 * @returns {Promise<string|null>} SOURCE value, or null when it is not a LIVCK page
 */
export const resolveSource = async (statuspage, { token = null } = {}) => {
    if (statuspage.kind) return statuspage.kind;

    const detected = await detectSource(statuspage.url, { token });
    if (!detected) return null;

    statuspage.kind = detected;
    if (typeof statuspage.save === 'function') {
        await statuspage.save();
    }

    logger.info(`[Providers] ${statuspage.url} detected as ${detected}`);
    return detected;
};

/** Raised when a page answers but is not a LIVCK status page at all. */
export class NotLivckError extends Error {
    constructor(url) {
        super(`not a LIVCK statuspage: ${url}`);
        this.name = 'NotLivckError';
        // Classified as NOT_LIVCK so the backoff and the pause notice say the right thing.
        this.kind = FAILURE_KINDS.NOT_LIVCK;
    }
}

const fetchFresh = async (statuspage, { token, locale }) => {
    const source = await resolveSource(statuspage, { token });

    if (source === SOURCE.CLOUD) {
        const { snapshot, pageId } = await cloudProvider.fetchSnapshot(statuspage);

        // Remembering the page id saves the /status.json lookup on every later cycle.
        if (pageId && statuspage.externalId !== pageId) {
            statuspage.externalId = pageId;
            if (typeof statuspage.save === 'function') await statuspage.save();
        }

        return snapshot;
    }

    if (source === SOURCE.SELF_HOSTED) {
        return selfHostedProvider.fetchSnapshot(statuspage, { token, locale, withAlerts: true });
    }

    throw new NotLivckError(statuspage.url);
};

/**
 * Fetch one snapshot, reusing an in-flight or very recent one for the same page, token and
 * locale.
 *
 * @param {object} statuspage - Statuspage row
 * @param {object} options
 * @param {string|null} [options.token]
 * @param {string} [options.locale]
 * @returns {Promise<object>} snapshot
 */
export const fetchSnapshot = async (statuspage, { token = null, locale = 'de' } = {}) => {
    const key = cacheKey(statuspage, token, locale);
    const cached = inFlight.get(key);

    if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) {
        return cached.promise;
    }

    const promise = fetchFresh(statuspage, { token, locale });
    rememberSnapshot(key, promise);

    return promise;
};

export default { fetchSnapshot, resolveSource, clearSnapshotCache, NotLivckError };
