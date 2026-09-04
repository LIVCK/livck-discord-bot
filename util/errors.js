/**
 * Error classification for statuspage fetches.
 *
 * One place decides what a failure IS, so the logger, the backoff and the pause
 * notification all say the same thing about the same error. Everything that talks to a
 * remote statuspage funnels through here.
 */

/**
 * Failure kinds. These double as `Statuspage.pauseReason` values, which is why the column
 * is a STRING and no longer an ENUM — adding a kind must not require a table alter.
 */
export const FAILURE_KINDS = {
    TIMEOUT: 'TIMEOUT',
    DNS: 'DNS',
    REFUSED: 'REFUSED',
    TLS: 'TLS',
    HTTP_4XX: 'HTTP_4XX',
    HTTP_5XX: 'HTTP_5XX',
    RATE_LIMITED: 'RATE_LIMITED',
    NOT_LIVCK: 'NOT_LIVCK',
    NETWORK: 'NETWORK',
    UNKNOWN: 'UNKNOWN',
};

/** Node/undici cause codes that mean "the name does not resolve". */
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENODATA']);
/** Cause codes that mean "reached the host, got no usable connection". */
const REFUSED_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE']);
const TIMEOUT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ETIMEDOUT']);

/**
 * An error we expect to see in normal operation — a customer's domain expiring, a proxy
 * hiccup, an overloaded origin. These are logged as a single line without a stack trace;
 * everything else keeps its stack, because an unexpected error is exactly where one helps.
 */
const EXPECTED_KINDS = new Set([
    FAILURE_KINDS.TIMEOUT,
    FAILURE_KINDS.DNS,
    FAILURE_KINDS.REFUSED,
    FAILURE_KINDS.TLS,
    FAILURE_KINDS.HTTP_4XX,
    FAILURE_KINDS.HTTP_5XX,
    FAILURE_KINDS.RATE_LIMITED,
    FAILURE_KINDS.NOT_LIVCK,
    FAILURE_KINDS.NETWORK,
]);

/**
 * Classify a fetch/HTTP failure.
 *
 * @param {Error|null|undefined} error
 * @returns {{kind: string, status: number|null, detail: string, expected: boolean}}
 */
export const classifyError = (error) => {
    if (!error) {
        return { kind: FAILURE_KINDS.UNKNOWN, status: null, detail: 'unknown error', expected: false };
    }

    const message = typeof error.message === 'string' ? error.message : String(error);
    const code = error.cause?.code || error.code;

    // An HttpError thrown by the API client carries the status directly; a plain Error
    // from an older call path still has it in the message ("HTTP 503: ...").
    const status = typeof error.status === 'number'
        ? error.status
        : (message.match(/HTTP (\d{3})/)?.[1] ? Number(message.match(/HTTP (\d{3})/)[1]) : null);

    if (status !== null) {
        if (status === 429) {
            return { kind: FAILURE_KINDS.RATE_LIMITED, status, detail: `HTTP ${status}`, expected: true };
        }
        const kind = status >= 500 ? FAILURE_KINDS.HTTP_5XX : FAILURE_KINDS.HTTP_4XX;
        return { kind, status, detail: `HTTP ${status}`, expected: true };
    }

    if (TIMEOUT_CODES.has(code) || /timeout/i.test(message)) {
        return { kind: FAILURE_KINDS.TIMEOUT, status: null, detail: code || 'timeout', expected: true };
    }
    if (DNS_CODES.has(code)) {
        return { kind: FAILURE_KINDS.DNS, status: null, detail: code, expected: true };
    }
    if (REFUSED_CODES.has(code)) {
        return { kind: FAILURE_KINDS.REFUSED, status: null, detail: code, expected: true };
    }
    if (typeof code === 'string' && (code.startsWith('ERR_TLS') || code.startsWith('CERT_') || code.startsWith('DEPTH_'))) {
        return { kind: FAILURE_KINDS.TLS, status: null, detail: code, expected: true };
    }
    if (/not a LIVCK|lvk-version/i.test(message)) {
        return { kind: FAILURE_KINDS.NOT_LIVCK, status: null, detail: 'no LIVCK marker', expected: true };
    }
    if (/fetch failed|network/i.test(message)) {
        return { kind: FAILURE_KINDS.NETWORK, status: null, detail: code || 'fetch failed', expected: true };
    }

    return { kind: FAILURE_KINDS.UNKNOWN, status: null, detail: message.slice(0, 200), expected: false };
};

/** True when a failure of this kind is routine and needs no stack trace. */
export const isExpectedFailure = (kind) => EXPECTED_KINDS.has(kind);

/**
 * HTTP error carrying its status, so callers can branch on it without parsing a message.
 */
export class HttpError extends Error {
    constructor(status, statusText, url) {
        super(`HTTP ${status}: ${statusText}`);
        this.name = 'HttpError';
        this.status = status;
        this.statusText = statusText;
        this.url = url;
    }
}
