/**
 * Reading a JSON body from a URL the bot does not control.
 *
 * Every status page the bot polls is a URL some guild admin typed into `/livck subscribe`.
 * `response.json()` buffers the WHOLE body before anyone can look at it, and Node's fetch
 * transparently decompresses — so 199 kB on the wire becomes 200 MB in memory, and the
 * `content-length` header, which reflects the compressed size, gives no warning at all.
 *
 * Measured: a 199 kB gzip response took RSS from 254 MB to 895 MB in 206 ms. The update loop
 * processes a batch of 100 pages CONCURRENTLY, so a handful of such pages is an out-of-memory
 * kill of a bot that serves every guild. It does not take malice either — a status page that
 * accidentally returns a huge export does the same thing.
 *
 * So the body is read in chunks and abandoned the moment it passes the cap, which is far above
 * any real status page (the largest of the reference pages is well under 200 kB) and far below
 * anything that hurts.
 */

import { HttpError } from './errors.js';

/** Refuse a body larger than this. Generous: real payloads are two orders of magnitude smaller. */
export const MAX_BODY_BYTES = Number(process.env.LIVCK_MAX_BODY_BYTES || 8 * 1024 * 1024);

/** Raised when a response body exceeds the cap. Classified like any other bad response. */
export class BodyTooLargeError extends HttpError {
    constructor(url, limit) {
        super(413, `response body exceeds ${limit} bytes`, url);
        this.name = 'BodyTooLargeError';
    }
}

/**
 * Read a fetch Response as JSON, giving up past `MAX_BODY_BYTES`.
 *
 * @param {Response} response
 * @param {string} url - for the error message
 * @param {number} [limit]
 * @returns {Promise<any>}
 */
export const readJsonCapped = async (response, url, limit = MAX_BODY_BYTES) => {
    // No body stream (some runtimes, and any mocked response in a test): fall back to the
    // plain read. Nothing is lost — a mock is not a hostile server.
    if (!response.body || typeof response.body.getReader !== 'function') {
        return response.json();
    }

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;

            total += value.byteLength;
            if (total > limit) {
                // Cancel, so the connection is torn down instead of quietly draining the
                // rest of the body in the background.
                await reader.cancel();
                throw new BodyTooLargeError(url, limit);
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock?.();
    }

    const body = Buffer.concat(chunks, total).toString('utf8');

    try {
        return JSON.parse(body);
    } catch (error) {
        throw new Error(`Invalid JSON from ${url}: ${error.message}`);
    }
};

export default { readJsonCapped, MAX_BODY_BYTES, BodyTooLargeError };
