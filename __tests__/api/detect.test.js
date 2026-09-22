import { classifyHeaders, detectSource } from '../../api/detect.js';
import { SOURCE } from '../../dto/statuspage.js';

/** Minimal Headers stand-in. */
const headers = (map) => ({
    get: (name) => map[name.toLowerCase()] ?? null,
    has: (name) => name.toLowerCase() in map,
});

describe('classifyHeaders', () => {
    test('recognises the Cloud by its server header', () => {
        // Recorded from cloud.statuspage.de and status.emeraldhost.de.
        expect(classifyHeaders(headers({ server: 'LIVCK Cloud', 'x-powered-by': 'LIVCK Cloud' })))
            .toBe(SOURCE.CLOUD);
    });

    test('recognises the Cloud by x-powered-by alone', () => {
        // A future CDN in front could overwrite `server`; the second marker survives that.
        expect(classifyHeaders(headers({ server: 'nginx', 'x-powered-by': 'LIVCK Cloud' })))
            .toBe(SOURCE.CLOUD);
    });

    test('is case insensitive', () => {
        expect(classifyHeaders(headers({ server: 'livck cloud' }))).toBe(SOURCE.CLOUD);
        expect(classifyHeaders(headers({ server: 'LIVCK CLOUD' }))).toBe(SOURCE.CLOUD);
    });

    test('recognises a self-hosted instance by lvk-version', () => {
        // Recorded from status.livck.com (behind Cloudflare) and fc-status.net (nginx) —
        // the marker survives both proxies.
        expect(classifyHeaders(headers({ server: 'cloudflare', 'lvk-version': '1.5.0' })))
            .toBe(SOURCE.SELF_HOSTED);
        expect(classifyHeaders(headers({ server: 'nginx', 'lvk-version': '1.5.0' })))
            .toBe(SOURCE.SELF_HOSTED);
    });

    test('an empty lvk-version still identifies the product', () => {
        expect(classifyHeaders(headers({ 'lvk-version': '' }))).toBe(SOURCE.SELF_HOSTED);
    });

    test('the Cloud marker wins over a stray lvk-version', () => {
        // Should never happen, but the Cloud claim is the more specific one.
        expect(classifyHeaders(headers({ server: 'LIVCK Cloud', 'lvk-version': '1.0' })))
            .toBe(SOURCE.CLOUD);
    });

    test('an unrelated server is neither', () => {
        expect(classifyHeaders(headers({ server: 'nginx' }))).toBeNull();
        expect(classifyHeaders(headers({}))).toBeNull();
        expect(classifyHeaders(null)).toBeNull();
    });

    test('a lookalike server header is not enough', () => {
        expect(classifyHeaders(headers({ server: 'LIVCK' }))).toBeNull();
        expect(classifyHeaders(headers({ server: 'not LIVCK Cloud really' }))).toBeNull();
    });
});

describe('detectSource', () => {
    let restore;

    const stubFetch = (impl) => {
        const original = globalThis.fetch;
        globalThis.fetch = impl;
        restore = () => { globalThis.fetch = original; };
    };

    afterEach(() => restore && restore());

    test('does not follow redirects — the Cloud 302 already carries the marker', async () => {
        let seen;
        stubFetch(async (_url, options) => {
            seen = options;
            return { status: 302, headers: headers({ server: 'LIVCK Cloud', location: '/de' }) };
        });

        await expect(detectSource('https://cloud.statuspage.de')).resolves.toBe(SOURCE.CLOUD);
        expect(seen.redirect).toBe('manual');
    });

    test('detects a self-hosted 200', async () => {
        stubFetch(async () => ({ status: 200, headers: headers({ 'lvk-version': '1.5.0' }) }));

        await expect(detectSource('https://status.livck.com')).resolves.toBe(SOURCE.SELF_HOSTED);
    });

    test('returns null for a non-LIVCK host rather than throwing', async () => {
        stubFetch(async () => ({ status: 200, headers: headers({ server: 'nginx' }) }));

        await expect(detectSource('https://example.com')).resolves.toBeNull();
    });

    test('throws when the host is unreachable, rather than calling it not-LIVCK', async () => {
        // These are DIFFERENT answers. Collapsing them into null told subscribers of a page
        // with an expired domain that it was "no longer a LIVCK status page", and made
        // `/livck subscribe` reject a valid URL during a network blip.
        stubFetch(async () => {
            const error = new Error('fetch failed');
            error.cause = { code: 'ENOTFOUND' };
            throw error;
        });

        await expect(detectSource('https://invalid.test')).rejects.toThrow('fetch failed');
    });

describe('a redirect', () => {
    /** Record every request so the second hop can be inspected. */
    const recording = (responses) => {
        const calls = [];
        stubFetch(async (url, options) => {
            calls.push({ url, options });
            const next = responses.shift();
            if (next instanceof Error) throw next;
            return next;
        });
        return calls;
    };

    test('is followed once when the first answer carries no marker', () => {
        // The Cloud's own 302 already carries the marker, which is why redirects are not
        // followed by default. Plenty of real deployments answer with one that does not: an
        // `http://` origin upgrading to https, an apex sending you to www, HSTS at a proxy.
        // Both reference pages do exactly that.
        recording([
            { status: 301, headers: headers({ location: 'https://status.example.com/' }) },
            { status: 200, headers: headers({ 'lvk-version': '1.5.0' }) },
        ]);

        return expect(detectSource('http://status.example.com')).resolves.toBe(SOURCE.SELF_HOSTED);
    });

    test('is not followed when the first answer already identified the page', async () => {
        // One request, not two, for the case redirects were disabled for.
        const calls = recording([
            { status: 302, headers: headers({ server: 'LIVCK Cloud', location: 'https://x/de' }) },
        ]);

        await expect(detectSource('https://cloud.example.com')).resolves.toBe(SOURCE.CLOUD);
        expect(calls).toHaveLength(1);
    });

    test('carries the API token to the same host', async () => {
        const calls = recording([
            { status: 308, headers: headers({ location: 'https://status.example.com/status' }) },
            { status: 200, headers: headers({ 'lvk-version': '1.5.0' }) },
        ]);

        await detectSource('https://status.example.com', { token: 'secret' });

        expect(calls).toHaveLength(2);
        expect(calls[1].options.headers.Authorization).toBe('Bearer secret');
    });

    test('DROPS the API token when the host changes', async () => {
        // A redirect can point anywhere. The token belongs to one customer's private status
        // page, and handing it to whatever is on the other end would turn a convenience into
        // a credential leak.
        const calls = recording([
            { status: 302, headers: headers({ location: 'https://someone-else.example.com/' }) },
            { status: 200, headers: headers({ 'lvk-version': '1.5.0' }) },
        ]);

        await detectSource('https://status.example.com', { token: 'secret' });

        expect(calls).toHaveLength(2);
        expect(calls[1].options.headers.Authorization).toBeUndefined();
        expect(JSON.stringify(calls[1])).not.toContain('secret');
    });

    test('is not followed to a scheme that cannot be a status page', async () => {
        const calls = recording([
            { status: 302, headers: headers({ location: 'javascript:alert(1)' }) },
        ]);

        await expect(detectSource('https://status.example.com')).resolves.toBeNull();
        expect(calls).toHaveLength(1);
    });

    test('is not followed to itself', async () => {
        const calls = recording([
            { status: 302, headers: headers({ location: 'https://status.example.com' }) },
        ]);

        await expect(detectSource('https://status.example.com')).resolves.toBeNull();
        expect(calls).toHaveLength(1);
    });

    test('a redirect with no destination is simply not a LIVCK page', async () => {
        recording([{ status: 302, headers: headers({}) }]);

        await expect(detectSource('https://status.example.com')).resolves.toBeNull();
    });

    test('resolves a relative destination against the original', async () => {
        const calls = recording([
            { status: 301, headers: headers({ location: '/de/status' }) },
            { status: 200, headers: headers({ server: 'LIVCK Cloud' }) },
        ]);

        await expect(detectSource('https://cloud.example.com/page')).resolves.toBe(SOURCE.CLOUD);
        expect(calls[1].url).toBe('https://cloud.example.com/de/status');
    });

    test('a second hop that fails throws rather than reading as "not LIVCK"', async () => {
        recording([
            { status: 301, headers: headers({ location: 'https://status.example.com/' }) },
            Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
        ]);

        await expect(detectSource('http://status.example.com')).rejects.toThrow('fetch failed');
    });

    test('only one hop, never a chain', async () => {
        // Two redirects in a row is a misconfiguration, not something to walk.
        const calls = recording([
            { status: 301, headers: headers({ location: 'https://a.example.com/' }) },
            { status: 301, headers: headers({ location: 'https://b.example.com/' }) },
        ]);

        await expect(detectSource('http://a.example.com')).resolves.toBeNull();
        expect(calls).toHaveLength(2);
    });
});

    test('sends the API token when one is configured', async () => {
        let seen;
        stubFetch(async (_url, options) => {
            seen = options;
            return { status: 200, headers: headers({ 'lvk-version': '1.5.0' }) };
        });

        await detectSource('https://private.example.com', { token: 'secret' });

        expect(seen.headers.Authorization).toBe('Bearer secret');
    });

    test('sets a deadline — a user is waiting on the subscribe reply', async () => {
        let seen;
        stubFetch(async (_url, options) => {
            seen = options;
            return { status: 200, headers: headers({}) };
        });

        await detectSource('https://slow.example.com');

        expect(seen.signal).toBeDefined();
    });
});
