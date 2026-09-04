import { jest } from '@jest/globals';
import LIVCK from '../../api/livck.js';
import { FAILURE_KINDS, classifyError } from '../../util/errors.js';

const TEST_URL = 'https://status.livck.com';

/**
 * Contract tests run against a stubbed `fetch`.
 *
 * They used to call the live status.livck.com, which meant an outage of that page failed the
 * build of the bot that reports outages. The live checks still exist below, behind
 * LIVCK_LIVE_TESTS=1, so they can be run deliberately.
 */
const stubFetch = (impl) => {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    return () => { globalThis.fetch = original; };
};

const jsonResponse = (body, { status = 200, headers = {} } = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: {
        get: (key) => ({ 'content-type': 'application/json', ...headers })[key.toLowerCase()] ?? null,
        has: (key) => key.toLowerCase() in { 'content-type': 1, ...headers },
    },
    json: async () => body,
});

describe('Client Initialization', () => {
    const client = new LIVCK(TEST_URL);

    test('should initialize with base URL', () => {
        expect(client.baseURL).toBe(TEST_URL);
        expect(client.apiVersion).toBe('v3');
        expect(client.token).toBeNull();
        expect(client.locale).toBeNull();
    });

    test('should initialize with locale', () => {
        expect(new LIVCK(TEST_URL, 'v3', null, 'de').locale).toBe('de');
    });

    test('should initialize with token and locale', () => {
        const full = new LIVCK(TEST_URL, 'v3', 'test-token', 'en');
        expect(full.token).toBe('test-token');
        expect(full.locale).toBe('en');
    });

    test('should build correct API paths', () => {
        expect(client.build('categories')).toContain('/api/v3/categories');
        expect(client.build('alerts', 'v1')).toContain('/api/v1/alerts');
    });
});

describe('Request headers', () => {
    let restore;
    afterEach(() => restore && restore());

    test('sends the bearer token when one is configured', async () => {
        let seen;
        restore = stubFetch(async (_url, options) => { seen = options.headers; return jsonResponse({ data: [] }); });

        await new LIVCK(TEST_URL, 'v3', 'secret-token').get('categories');

        expect(seen.Authorization).toBe('Bearer secret-token');
    });

    test('omits Authorization when there is no token', async () => {
        let seen;
        restore = stubFetch(async (_url, options) => { seen = options.headers; return jsonResponse({ data: [] }); });

        await new LIVCK(TEST_URL).get('categories');

        expect(seen.Authorization).toBeUndefined();
    });

    test('asks for the subscription locale', async () => {
        let seen;
        restore = stubFetch(async (_url, options) => { seen = options.headers; return jsonResponse({ data: [] }); });

        await new LIVCK(TEST_URL, 'v3', null, 'de').get('categories');

        expect(seen['Accept-Language']).toBe('de');
    });

    test('carries query parameters', async () => {
        let seen;
        restore = stubFetch(async (url) => { seen = url; return jsonResponse({ data: [] }); });

        await new LIVCK(TEST_URL).get('categories', { perPage: 100 });

        expect(seen).toContain('perPage=100');
    });

    test('sets a deadline so a stalled connection cannot hang the cycle', async () => {
        let seen;
        restore = stubFetch(async (_url, options) => { seen = options; return jsonResponse({ data: [] }); });

        await new LIVCK(TEST_URL).get('categories');

        expect(seen.signal).toBeDefined();
        expect(typeof seen.signal.aborted).toBe('boolean');
    });
});

/**
 * The behaviour Phase 0 changed on purpose.
 *
 * `get()` used to catch everything and return `{data: []}`, which made an unreachable status
 * page indistinguishable from an empty one — the update loop saw "no categories", never an
 * error, and the backoff could never engage.
 */
describe('Error propagation', () => {
    let restore;
    afterEach(() => restore && restore());

    test('an HTTP error throws and carries its status', async () => {
        restore = stubFetch(async () => jsonResponse({}, { status: 404 }));

        await expect(new LIVCK(TEST_URL).get('nonexistent')).rejects.toMatchObject({
            name: 'HttpError',
            status: 404,
        });
    });

    test('a 5xx is classified as a server failure, not a client one', async () => {
        restore = stubFetch(async () => jsonResponse({}, { status: 503 }));

        const error = await new LIVCK(TEST_URL).get('categories').catch((e) => e);
        expect(classifyError(error).kind).toBe(FAILURE_KINDS.HTTP_5XX);
    });

    test('a 403 throws rather than looking like an empty page', async () => {
        restore = stubFetch(async () => jsonResponse({}, { status: 403 }));

        const error = await new LIVCK(TEST_URL, 'v3', 'wrong-token').get('categories').catch((e) => e);
        expect(classifyError(error).kind).toBe(FAILURE_KINDS.HTTP_4XX);
    });

    test('a network failure propagates', async () => {
        restore = stubFetch(async () => {
            const error = new Error('fetch failed');
            error.cause = { code: 'ENOTFOUND' };
            throw error;
        });

        const error = await new LIVCK('https://invalid.test').get('categories').catch((e) => e);
        expect(classifyError(error).kind).toBe(FAILURE_KINDS.DNS);
    });

    test('a non-JSON response throws instead of being parsed', async () => {
        // A parked domain or a captive portal answers 200 with HTML; treating that as data
        // would put nonsense into a status embed.
        restore = stubFetch(async () => jsonResponse('<html>', { headers: { 'content-type': 'text/html' } }));

        await expect(new LIVCK(TEST_URL).get('categories')).rejects.toThrow(/Expected JSON/);
    });

    test('a successful response is returned untouched', async () => {
        restore = stubFetch(async () => jsonResponse({ data: [{ id: 'a', name: 'X' }] }));

        await expect(new LIVCK(TEST_URL).get('categories')).resolves.toEqual({ data: [{ id: 'a', name: 'X' }] });
    });
});

describe('ensureIsLIVCK', () => {
    let restore;
    afterEach(() => restore && restore());

    test('true when the lvk-version header is present', async () => {
        restore = stubFetch(async () => ({ headers: { has: (k) => k === 'lvk-version' } }));

        await expect(new LIVCK(TEST_URL).ensureIsLIVCK()).resolves.toBe(true);
    });

    test('false when the header is missing', async () => {
        restore = stubFetch(async () => ({ headers: { has: () => false } }));

        await expect(new LIVCK('https://example.com').ensureIsLIVCK()).resolves.toBe(false);
    });

    test('false — never a throw — when the host is unreachable', async () => {
        restore = stubFetch(async () => { throw new Error('fetch failed'); });

        await expect(new LIVCK('https://invalid.test').ensureIsLIVCK()).resolves.toBe(false);
    });
});

/**
 * Live checks against the real status page. Opt in with LIVCK_LIVE_TESTS=1 — they are not
 * part of CI, where a third-party outage must not fail the build.
 */
const live = process.env.LIVCK_LIVE_TESTS === '1' ? describe : describe.skip;

live('Live status.livck.com', () => {
    const client = new LIVCK(TEST_URL);

    test('is recognised as a LIVCK instance', async () => {
        await expect(client.ensureIsLIVCK()).resolves.toBe(true);
    }, 15000);

    test('returns categories', async () => {
        const response = await client.get('categories', { perPage: 100 });
        expect(typeof response).toBe('object');
    }, 15000);

    test('answers within five seconds', async () => {
        const started = Date.now();
        await client.get('categories', { perPage: 100 });
        expect(Date.now() - started).toBeLessThan(5000);
    }, 15000);
});
