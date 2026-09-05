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
