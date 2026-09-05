import { HttpError } from '../util/errors.js';
import { readJsonCapped } from '../util/readJson.js';
import logger from '../util/logger.js';

/**
 * Client for a self-hosted LIVCK status page (`/api/v3`, `/api/v1`).
 *
 * ERRORS PROPAGATE. `get()` used to catch everything and return `{data: []}`, which made an
 * unreachable status page indistinguishable from an empty one: the update loop saw "no
 * categories", never an error, so the backoff never engaged and the page was polled every
 * 15 seconds forever. Callers now decide what a failure means; this class only classifies
 * and reports it.
 */

/** Give up on a request after this long. Must stay below the update interval. */
const REQUEST_TIMEOUT_MS = Number(process.env.LIVCK_TIMEOUT_MS || 10_000);

export default class LIVCK {

    constructor(baseUrl = 'https://status.livck.com/api', apiVersion = 'v3', token = null, locale = null) {
        this.baseURL = baseUrl
        this.apiVersion = apiVersion
        this.token = token || null
        this.locale = locale || null
    }

    build(path, version = this.apiVersion) {
        return `${this.baseURL}/api/${version}/${path}`
    }

    async request(method, path, params = {}, query = {}, apiVersion = this.apiVersion) {
        const url = new URL(this.build(path, apiVersion))
        Object.entries(query).forEach(([key, value]) => url.searchParams.append(key, value))

        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        }

        if (this.token) {
            headers['Authorization'] = `Bearer ${this.token}`
        }

        if (this.locale) {
            headers['Accept-Language'] = this.locale
        }

        // Without an explicit deadline a stalled connection hangs for undici's default
        // (minutes), holding up the whole cycle and never surfacing as an error.
        const response = await fetch(url.toString(), {
            method: method,
            headers,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            ...params,
        })

        if (!response.ok) {
            throw new HttpError(response.status, response.statusText, url.toString())
        }

        const contentType = response.headers.get('content-type')
        if (!contentType || !contentType.includes('application/json')) {
            throw new Error(`Expected JSON response, got: ${contentType}`)
        }

        // Capped: the URL belongs to a customer, and an unbounded body is an OOM away from
        // taking the bot down for every guild. See util/readJson.js.
        return readJsonCapped(response, url.toString())
    }

    /**
     * Perform a GET. Throws on any failure — see the class docblock.
     */
    async get(path, query = {}, apiVersion = this.apiVersion) {
        return this.request('GET', path, {}, query, apiVersion)
    }

    /**
     * Is this URL a LIVCK status page?
     *
     * Self-hosted instances answer with an `lvk-version` header. This is the one place that
     * still swallows its error: the caller only asks a yes/no question, and "unreachable"
     * and "not LIVCK" lead to the same answer here.
     */
    async ensureIsLIVCK() {
        const fetchOptions = { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
        if (this.token) {
            fetchOptions.headers = { 'Authorization': `Bearer ${this.token}` }
        }

        const response = await fetch(this.baseURL, fetchOptions).catch((error) => {
            logger.failure('[LIVCK] ensureIsLIVCK', this.baseURL, error)
            return null
        })

        if (!response) {
            return false
        }

        return response.headers.has('lvk-version')
    }

}
