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

/**
 * What actually makes two fetches different.
 *
 * For a CLOUD page: nothing but the page itself. `/full` ships every language in one payload
 * and takes no token, so a key carrying the locale split one request into one per language.
 * Subscriptions are grouped by (token, locale) for both backends, so a Cloud page watched from
 * channels in three languages issued three byte-identical requests every cycle — and the bot
 * offers thirteen. Thirteen locales × four cycles a minute is 52 requests a minute for a
 * single page, against the shared edge budget this memo exists to protect.
 *
 * For a SELF-HOSTED page both matter: the locale is sent as `Accept-Language` and decides what
 * comes back, and the token decides what the caller is allowed to see. Dropping either would
 * serve one subscription's private page to another — so the key keeps them, always.
 */
const cacheKey = (statuspage, token, locale, source) =>
    source === SOURCE.CLOUD
        ? `${statuspage.url}::cloud`
        : `${statuspage.url}::${token || ''}::${locale}`;

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
export const clearSnapshotCache = () => {
    inFlight.clear();
    closedAlerts.clear();
};

/**
 * Alerts recovered after they left the live payload, memoized per (page, alert) for the same
 * window as a snapshot.
 *
 * Several subscriptions usually watch the same status page, and every one of them notices the
 * same alert vanish in the same cycle. Without this they would each pay for the lookup.
 */
const closedAlerts = new Map();

/**
 * Recover an alert the live payload no longer contains — see providers/cloud.js.
 *
 * Self-hosted pages never need this: their `/api/v1/alerts` keeps a resolved alert in the list
 * (it is filtered by age, not by state), so nothing ever disappears mid-timeline. The call is
 * therefore Cloud-only and returns null everywhere else.
 *
 * @returns {Promise<object|null>} DTO alert, or null when it cannot be confirmed
 */
export const fetchClosedAlert = async (statuspage, alertId, expectedKind = null) => {
    if (statuspage.kind !== SOURCE.CLOUD) return null;

    const key = `${statuspage.url}::${alertId}`;
    const cached = closedAlerts.get(key);
    if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) {
        return cached.promise;
    }

    if (closedAlerts.size >= MAX_CACHE_ENTRIES) {
        const oldest = closedAlerts.keys().next().value;
        if (oldest !== undefined) closedAlerts.delete(oldest);
    }

    const promise = cloudProvider.fetchClosedAlert(statuspage, alertId, expectedKind);
    closedAlerts.set(key, { at: Date.now(), promise });
    promise.catch(() => closedAlerts.delete(key));

    return promise;
};

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
    // The kind decides what the key looks like, so it has to be known first. This costs
    // nothing in steady state: it is read straight off the row after the first detection.
    const source = statuspage.kind || null;
    const key = cacheKey(statuspage, token, locale, source);
    const cached = inFlight.get(key);

    if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) {
        return cached.promise;
    }

    const promise = fetchFresh(statuspage, { token, locale });
    rememberSnapshot(key, promise);

    // An undetected page keys as self-hosted above, which is the conservative choice — but the
    // fetch itself may have discovered it is a Cloud page. Publish it under the Cloud key too,
    // so the very first cycle already shares one request across every language rather than
    // paying for the split exactly once per page.
    promise.then(() => {
        if (statuspage.kind === SOURCE.CLOUD && !source) {
            rememberSnapshot(cacheKey(statuspage, token, locale, SOURCE.CLOUD), promise);
        }
    }).catch(() => {});

    return promise;
};

export default { fetchSnapshot, fetchClosedAlert, resolveSource, clearSnapshotCache, NotLivckError };
