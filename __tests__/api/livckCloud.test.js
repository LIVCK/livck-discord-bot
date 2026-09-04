import LIVCKCloud from '../../api/livckCloud.js';
import { FAILURE_KINDS, classifyError } from '../../util/errors.js';

const jsonResponse = (body, { status = 200, contentType = 'application/json' } = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { get: (key) => (key.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => body,
});

const STATUS_JSON = { page: { id: 'tnKPnxfQBhXlkepaIobN8', name: 'LIVCK Cloud Status' } };

let restore;
let calls;

const stubFetch = (handler) => {
    const original = globalThis.fetch;
    calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push(url);
        return handler(url, options);
    };
    restore = () => { globalThis.fetch = original; };
};

afterEach(() => restore && restore());

describe('construction', () => {
    test('a trailing slash does not produce a double slash in requests', async () => {
        stubFetch(async () => jsonResponse(STATUS_JSON));

        await new LIVCKCloud('https://cloud.statuspage.de/').fetchStatus();

        expect(calls[0]).toBe('https://cloud.statuspage.de/status.json');
    });
});

describe('page id resolution', () => {
    test('reads the id out of status.json', async () => {
        stubFetch(async () => jsonResponse(STATUS_JSON));

        const client = new LIVCKCloud('https://cloud.statuspage.de');
        await expect(client.resolvePageId()).resolves.toBe('tnKPnxfQBhXlkepaIobN8');
    });

    test('a known id skips the lookup entirely', async () => {
        // Persisted on the Statuspage row, so the ordinary cycle costs one request, not two.
        stubFetch(async () => jsonResponse(STATUS_JSON));

        const client = new LIVCKCloud('https://cloud.statuspage.de', 'already-known');
        await expect(client.resolvePageId()).resolves.toBe('already-known');
        expect(calls).toHaveLength(0);
    });

    test('the id is looked up once and remembered', async () => {
        stubFetch(async (url) => (url.endsWith('/status.json')
            ? jsonResponse(STATUS_JSON)
            : jsonResponse({ meta: {}, components: [] })));

        const client = new LIVCKCloud('https://cloud.statuspage.de');
        await client.fetchFull();
        await client.fetchFull();

        expect(calls.filter((u) => u.endsWith('/status.json'))).toHaveLength(1);
    });

    test('a status.json without a page id fails loudly', async () => {
        stubFetch(async () => jsonResponse({ page: {} }));

        await expect(new LIVCKCloud('https://x.test').resolvePageId()).rejects.toThrow(/No page id/);
    });
});

describe('endpoints', () => {
    beforeEach(() => {
        stubFetch(async (url) => (url.endsWith('/status.json')
            ? jsonResponse(STATUS_JSON)
            : jsonResponse({ ok: true })));
    });

    test('fetchFull addresses the page by its id', async () => {
        await new LIVCKCloud('https://cloud.statuspage.de').fetchFull();

        expect(calls).toContain('https://cloud.statuspage.de/api/statuspage/tnKPnxfQBhXlkepaIobN8/full');
    });

    test('fetchHistory addresses a page of the archive', async () => {
        await new LIVCKCloud('https://cloud.statuspage.de').fetchHistory(2);

        expect(calls).toContain('https://cloud.statuspage.de/api/statuspage/tnKPnxfQBhXlkepaIobN8/history/2');
    });

    test('history defaults to the first page', async () => {
        await new LIVCKCloud('https://cloud.statuspage.de').fetchHistory();

        expect(calls.some((u) => u.endsWith('/history/1'))).toBe(true);
    });
});

describe('failures', () => {
    test('a protected page 404s and the error carries the status', async () => {
        // A Cloud page that is password- or whitelist-protected answers 404 on every
        // unauthenticated surface. The bot uses exactly this to tell the user why.
        stubFetch(async () => jsonResponse({}, { status: 404 }));

        const error = await new LIVCKCloud('https://private.example.com').fetchStatus().catch((e) => e);

        expect(error.status).toBe(404);
        expect(classifyError(error).kind).toBe(FAILURE_KINDS.HTTP_4XX);
    });

    test('a 503 is classified as a server failure so the backoff engages', async () => {
        stubFetch(async () => jsonResponse({}, { status: 503 }));

        const error = await new LIVCKCloud('https://x.test').fetchStatus().catch((e) => e);
        expect(classifyError(error).kind).toBe(FAILURE_KINDS.HTTP_5XX);
    });

    test('an HTML response is rejected rather than parsed', async () => {
        // A parked domain or a captive portal answers 200 with HTML.
        stubFetch(async () => jsonResponse('<html>', { contentType: 'text/html' }));

        await expect(new LIVCKCloud('https://x.test').fetchStatus()).rejects.toThrow(/Expected JSON/);
    });

    test('requests carry a deadline', async () => {
        let seen;
        const original = globalThis.fetch;
        globalThis.fetch = async (_url, options) => { seen = options; return jsonResponse(STATUS_JSON); };
        restore = () => { globalThis.fetch = original; };

        await new LIVCKCloud('https://x.test').fetchStatus();

        expect(seen.signal).toBeDefined();
        expect(seen.headers.Accept).toBe('application/json');
    });
});
