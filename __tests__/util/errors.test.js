import { classifyError, isExpectedFailure, FAILURE_KINDS, HttpError } from '../../util/errors.js';

const withCause = (message, code) => {
    const error = new Error(message);
    error.cause = { code };
    return error;
};

describe('a page that answers with something other than JSON', () => {
    // The documented Cloudflare Bot-Shield case from CLAUDE.md, plus any origin serving an
    // interstitial or a static maintenance page. It fell through to UNKNOWN, which told
    // subscribers "Unbekannter Fehler" — the one reason that says nothing actionable — and,
    // because UNKNOWN is not an expected kind, printed a full stack trace on every attempt
    // all the way up the backoff ladder.
    test.each([
        'Expected JSON response, got: text/html',
        'Expected JSON response, got: null',
        'Invalid JSON from https://status.example.com: Unexpected token < in JSON at position 0',
    ])('%s is classified, not unknown', (message) => {
        const info = classifyError(new Error(message));

        expect(info.kind).toBe(FAILURE_KINDS.NOT_JSON);
    });

    test('and is routine, so it costs one line rather than a stack trace per attempt', () => {
        expect(isExpectedFailure(FAILURE_KINDS.NOT_JSON)).toBe(true);
    });

    test('an actually unknown error keeps its stack', () => {
        expect(isExpectedFailure(classifyError(new Error('something nobody predicted')).kind)).toBe(false);
    });
});

describe('classifyError', () => {
    test('HttpError carries its status through', () => {
        const result = classifyError(new HttpError(503, 'Service Unavailable', 'https://x'));
        expect(result.kind).toBe(FAILURE_KINDS.HTTP_5XX);
        expect(result.status).toBe(503);
    });

    test('4xx and 5xx are separate kinds', () => {
        expect(classifyError(new HttpError(404, 'Not Found')).kind).toBe(FAILURE_KINDS.HTTP_4XX);
        expect(classifyError(new HttpError(403, 'Forbidden')).kind).toBe(FAILURE_KINDS.HTTP_4XX);
        expect(classifyError(new HttpError(500, 'Server Error')).kind).toBe(FAILURE_KINDS.HTTP_5XX);
    });

    test('429 is its own kind, not a generic 4xx', () => {
        // The Cloud edge answers 429 with Retry-After; conflating it with 404 would make the
        // bot back off the same way for "you are too fast" and "this page is gone".
        expect(classifyError(new HttpError(429, 'Too Many Requests')).kind).toBe(FAILURE_KINDS.RATE_LIMITED);
    });

    test('a status embedded in a plain message is still recognised', () => {
        expect(classifyError(new Error('HTTP 502: Bad Gateway')).kind).toBe(FAILURE_KINDS.HTTP_5XX);
    });

    test.each([
        ['UND_ERR_CONNECT_TIMEOUT', FAILURE_KINDS.TIMEOUT],
        ['UND_ERR_HEADERS_TIMEOUT', FAILURE_KINDS.TIMEOUT],
        ['ETIMEDOUT', FAILURE_KINDS.TIMEOUT],
        ['ENOTFOUND', FAILURE_KINDS.DNS],
        ['EAI_AGAIN', FAILURE_KINDS.DNS],
        ['ECONNREFUSED', FAILURE_KINDS.REFUSED],
        ['ECONNRESET', FAILURE_KINDS.REFUSED],
        ['CERT_HAS_EXPIRED', FAILURE_KINDS.TLS],
        ['ERR_TLS_CERT_ALTNAME_INVALID', FAILURE_KINDS.TLS],
    ])('cause code %s maps to %s', (code, expected) => {
        expect(classifyError(withCause('fetch failed', code)).kind).toBe(expected);
    });

    test('a bare fetch failure is a network error', () => {
        expect(classifyError(new Error('fetch failed')).kind).toBe(FAILURE_KINDS.NETWORK);
    });

    test('a missing LIVCK marker is recognised', () => {
        expect(classifyError(new Error('not a LIVCK statuspage')).kind).toBe(FAILURE_KINDS.NOT_LIVCK);
    });

    test('anything unrecognised stays UNKNOWN and unexpected', () => {
        const result = classifyError(new TypeError('x.y is not a function'));
        expect(result.kind).toBe(FAILURE_KINDS.UNKNOWN);
        expect(result.expected).toBe(false);
    });

    test('nullish input does not throw', () => {
        expect(classifyError(null).kind).toBe(FAILURE_KINDS.UNKNOWN);
        expect(classifyError(undefined).kind).toBe(FAILURE_KINDS.UNKNOWN);
    });

    test('long unknown messages are capped so a log line stays a log line', () => {
        expect(classifyError(new Error('x'.repeat(5000))).detail.length).toBeLessThanOrEqual(200);
    });
});

describe('isExpectedFailure', () => {
    test('routine network conditions need no stack trace', () => {
        for (const kind of [
            FAILURE_KINDS.TIMEOUT, FAILURE_KINDS.DNS, FAILURE_KINDS.REFUSED,
            FAILURE_KINDS.TLS, FAILURE_KINDS.HTTP_4XX, FAILURE_KINDS.HTTP_5XX,
            FAILURE_KINDS.RATE_LIMITED, FAILURE_KINDS.NOT_LIVCK, FAILURE_KINDS.NETWORK,
        ]) {
            expect(isExpectedFailure(kind)).toBe(true);
        }
    });

    test('an unknown failure keeps its stack', () => {
        expect(isExpectedFailure(FAILURE_KINDS.UNKNOWN)).toBe(false);
    });
});
