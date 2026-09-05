import { SOURCE } from '../dto/statuspage.js';
import logger from '../util/logger.js';

/**
 * Decide whether a URL is a self-hosted LIVCK instance, a LIVCK Cloud page, or neither.
 *
 * ONE REQUEST, NO BODY. Both products announce themselves in response headers, and both do so
 * on the very first response:
 *
 *   Cloud        `server: LIVCK Cloud` (and `x-powered-by: LIVCK Cloud`)
 *   Self-hosted  `lvk-version: <version>`
 *
 * The Cloud answers `/` with a 302 to its locale prefix, so redirects are NOT followed —
 * `redirect: 'manual'` keeps it at one request and the 302 already carries the marker. A
 * self-hosted instance answers 200 with its own marker. Following the redirect would work too
 * but costs a second round trip on every page the bot ever validates.
 *
 * The two surfaces are also disjoint (the Cloud 404s on `/api/v3/categories`, self-hosted 404s
 * on `/status.json`), so a false positive would need a server that sets a LIVCK header without
 * being LIVCK.
 */

const CLOUD_MARKER = 'livck cloud';
const SELF_HOSTED_HEADER = 'lvk-version';

/** Give up quickly — this runs while a user waits on a `/livck subscribe` reply. */
const DETECT_TIMEOUT_MS = Number(process.env.LIVCK_DETECT_TIMEOUT_MS || 8000);

/**
 * Classify a set of response headers.
 *
 * Exported separately from the fetch so the mapping can be tested against recorded headers
 * without a network call.
 *
 * @param {Headers|{get: (name: string) => string|null, has?: (name: string) => boolean}} headers
 * @returns {string|null} SOURCE.CLOUD, SOURCE.SELF_HOSTED, or null
 */
export const classifyHeaders = (headers) => {
    if (!headers) return null;

    const read = (name) => {
        const value = typeof headers.get === 'function' ? headers.get(name) : null;
        return typeof value === 'string' ? value.toLowerCase() : null;
    };

    // Cloud first: it is the more specific claim. A proxy in front of a self-hosted instance
    // could plausibly set `server`, but not to this exact value.
    const server = read('server');
    const poweredBy = read('x-powered-by');
    if (server === CLOUD_MARKER || poweredBy === CLOUD_MARKER) {
        return SOURCE.CLOUD;
    }

    if (read(SELF_HOSTED_HEADER) !== null) {
        return SOURCE.SELF_HOSTED;
    }

    // `has()` covers a header present but empty, which still identifies the product.
    if (typeof headers.has === 'function' && headers.has(SELF_HOSTED_HEADER)) {
        return SOURCE.SELF_HOSTED;
    }

    return null;
};

const isRedirect = (status) => status >= 300 && status < 400;

/** Absolute target of a `location` header, or null when there is nothing usable to follow. */
const resolveLocation = (from, location) => {
    if (!location) return null;
    try {
        const target = new URL(location, from);
        // http and https only: a redirect to any other scheme is not a status page.
        if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
        // A self-referencing redirect would just be a second identical request.
        if (target.href === from) return null;
        return target.href;
    } catch {
        return null;
    }
};

/**
 * Probe a status page URL.
 *
 * "I could not reach it" and "it answered, and it is not LIVCK" are DIFFERENT answers, and an
 * earlier version returned null for both. That was wrong in the two places it mattered: a page
 * whose domain had expired told its subscribers "no longer a LIVCK status page" — blaming the
 * customer for a DNS outage — and `/livck subscribe` rejected a perfectly valid URL during a
 * network blip. So a transport failure THROWS (already classified, so the backoff and the
 * pause notice name the real cause) and null means only the second thing.
 *
 * @param {string} url - origin, e.g. `https://status.example.com`
 * @param {object} [options]
 * @param {string|null} [options.token] - API token for a private self-hosted page
 * @returns {Promise<string|null>} SOURCE.CLOUD, SOURCE.SELF_HOSTED, or null when the page
 *   answered but carries no LIVCK marker.
 * @throws when the page could not be reached at all (DNS, TLS, timeout, refused).
 */
export const detectSource = async (url, { token = null } = {}) => {
    const options = {
        // The Cloud's 302 already carries the marker; following it would double the cost.
        redirect: 'manual',
        signal: AbortSignal.timeout(DETECT_TIMEOUT_MS),
        headers: {},
    };

    if (token) {
        options.headers.Authorization = `Bearer ${token}`;
    }

    let response;
    try {
        response = await fetch(url, options);
    } catch (error) {
        logger.failure('[Detect]', url, error);
        throw error;
    }

    let source = classifyHeaders(response.headers);

    // ONE HOP, when the first answer is only a signpost.
    //
    // The Cloud's 302 to its locale prefix carries the marker, which is why redirects are not
    // followed by default. Plenty of real deployments answer with a redirect that does NOT:
    // an `http://` origin upgrading to https, an apex sending you to www, HSTS at the proxy.
    // Both reference pages do it — status.livck.com answers `http://` with a bare Cloudflare
    // 301, cloud.statuspage.de with a Caddy 308 — and without this every one of them was
    // classified "not a LIVCK page". That matters most on the first cycle after deploy, when
    // every existing row still has `kind = null` and is detected for the first time.
    if (!source && isRedirect(response.status)) {
        const target = resolveLocation(url, response.headers.get('location'));

        if (target) {
            // The token is dropped when the host changes. It belongs to one customer's status
            // page, and a redirect can point anywhere — handing it to whatever is on the other
            // end would turn a convenience into a credential leak.
            const sameHost = new URL(target).host === new URL(url).host;
            const followOptions = sameHost ? options : { ...options, headers: {} };

            try {
                const hop = await fetch(target, { ...followOptions, signal: AbortSignal.timeout(DETECT_TIMEOUT_MS) });
                source = classifyHeaders(hop.headers);
                logger.debug(`[Detect] ${url} → ${target} (HTTP ${response.status}) → ${source ?? 'not LIVCK'}`);
                return source;
            } catch (error) {
                logger.failure('[Detect]', target, error);
                throw error;
            }
        }
    }

    logger.debug(`[Detect] ${url} → ${source ?? 'not LIVCK'} (HTTP ${response.status})`);

    return source;
};

export default { detectSource, classifyHeaders };
