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

/**
 * Probe a status page URL.
 *
 * @param {string} url - origin, e.g. `https://status.example.com`
 * @param {object} [options]
 * @param {string|null} [options.token] - API token for a private self-hosted page
 * @returns {Promise<string|null>} SOURCE.CLOUD, SOURCE.SELF_HOSTED, or null when it is neither
 *   or unreachable. Never throws: the caller asks a yes/no question and both failure modes
 *   lead to the same answer.
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

    const response = await fetch(url, options).catch((error) => {
        logger.failure('[Detect]', url, error);
        return null;
    });

    if (!response) return null;

    const source = classifyHeaders(response.headers);
    logger.debug(`[Detect] ${url} → ${source ?? 'not LIVCK'} (HTTP ${response.status})`);

    return source;
};

export default { detectSource, classifyHeaders };
