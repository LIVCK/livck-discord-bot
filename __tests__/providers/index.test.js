/**
 * The provider registry: picking an adapter, remembering what a page is, and making sure the
 * two handlers do not each pay for the same fetch.
 */

import { jest } from '@jest/globals';

const detect = { result: null, error: null, calls: 0 };
const cloud = { calls: 0, pageId: 'cloud-page-id', closedCalls: 0, closedThrows: false, lastExpectedKind: undefined };
const selfHosted = { calls: 0 };

jest.unstable_mockModule('../../api/detect.js', () => ({
    detectSource: async () => {
        detect.calls += 1;
        if (detect.error) throw detect.error;
        return detect.result;
    },
    classifyHeaders: () => null,
    default: {},
}));

jest.unstable_mockModule('../../providers/cloud.js', () => ({
    fetchSnapshot: async () => {
        cloud.calls += 1;
        return { snapshot: { source: 'CLOUD', groups: [], alerts: [] }, pageId: cloud.pageId };
    },
    fetchClosedAlert: async (_page, _id, expectedKind) => {
        cloud.closedCalls += 1;
        cloud.lastExpectedKind = expectedKind;
        if (cloud.closedThrows) throw new Error('lookup failed');
        return { id: _id, kind: expectedKind ?? 'incident' };
    },
    toSnapshot: () => ({}),
    flattenTree: () => [],
    splitUpdates: () => ({ body: null, updates: [] }),
    normalizeStatus: (s) => s,
    default: {},
}));

jest.unstable_mockModule('../../providers/selfHosted.js', () => ({
    fetchSnapshot: async () => {
        selfHosted.calls += 1;
        return { source: 'SELF_HOSTED', groups: [], alerts: [] };
    },
    toSnapshot: () => ({}),
    groupStatus: () => 'operational',
    overallStatus: () => 'operational',
    mapServiceState: (s) => s,
    default: {},
}));

const { fetchSnapshot, fetchClosedAlert, resolveSource, clearSnapshotCache, NotLivckError } =
    await import('../../providers/index.js');
const { SOURCE } = await import('../../dto/statuspage.js');

const makePage = (overrides = {}) => {
    const page = {
        id: 1,
        url: 'https://status.example.com',
        name: 'Example',
        kind: null,
        externalId: null,
        saves: 0,
        save: async () => { page.saves += 1; },
        ...overrides,
    };
    return page;
};

beforeEach(() => {
    detect.result = null;
    detect.error = null;
    detect.calls = 0;
    cloud.calls = 0;
    cloud.pageId = 'cloud-page-id';
    cloud.closedCalls = 0;
    cloud.closedThrows = false;
    cloud.lastExpectedKind = undefined;
    selfHosted.calls = 0;
    clearSnapshotCache();
});

describe('resolveSource', () => {
    test('probes an unknown page and stores the answer', async () => {
        detect.result = SOURCE.CLOUD;
        const page = makePage();

        await expect(resolveSource(page)).resolves.toBe(SOURCE.CLOUD);
        expect(page.kind).toBe(SOURCE.CLOUD);
        expect(page.saves).toBe(1);
    });

    test('a page that already knows its kind is not probed again', async () => {
        // Detection costs a request; paying it every cycle for every page would be the same
        // mistake the redundant alert fetch was.
        const page = makePage({ kind: SOURCE.SELF_HOSTED });

        await expect(resolveSource(page)).resolves.toBe(SOURCE.SELF_HOSTED);
        expect(detect.calls).toBe(0);
    });

    test('a page that answers without a marker is not remembered as anything', async () => {
        detect.result = null;
        const page = makePage();

        await expect(resolveSource(page)).resolves.toBeNull();
        expect(page.kind).toBeNull();
        expect(page.saves).toBe(0);
    });

    test('an unreachable page fails as unreachable, not as "not LIVCK"', async () => {
        // The distinction reaches a customer's Discord channel: the pause notice names the
        // reason, and "no longer a LIVCK status page" for what is really a DNS outage blames
        // the wrong party. It also has to stay probeable once the domain comes back.
        detect.error = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
        const page = makePage();

        await expect(resolveSource(page)).rejects.toThrow('fetch failed');
        expect(page.kind).toBeNull();
        expect(page.saves).toBe(0);
    });

    test('the failure keeps its kind all the way up through fetchSnapshot', async () => {
        const { classifyError, FAILURE_KINDS } = await import('../../util/errors.js');
        detect.error = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });

        const error = await fetchSnapshot(makePage()).catch((e) => e);

        expect(error).not.toBeInstanceOf(NotLivckError);
        expect(classifyError(error).kind).toBe(FAILURE_KINDS.DNS);
    });
});

describe('adapter selection', () => {
    test('a Cloud page goes to the Cloud adapter', async () => {
        const page = makePage({ kind: SOURCE.CLOUD });

        await expect(fetchSnapshot(page)).resolves.toMatchObject({ source: 'CLOUD' });
        expect(cloud.calls).toBe(1);
        expect(selfHosted.calls).toBe(0);
    });

    test('a self-hosted page goes to the self-hosted adapter', async () => {
        const page = makePage({ kind: SOURCE.SELF_HOSTED });

        await expect(fetchSnapshot(page)).resolves.toMatchObject({ source: 'SELF_HOSTED' });
        expect(selfHosted.calls).toBe(1);
        expect(cloud.calls).toBe(0);
    });

    test('a page that is neither raises an error the backoff understands', async () => {
        detect.result = null;

        await expect(fetchSnapshot(makePage())).rejects.toBeInstanceOf(NotLivckError);
    });

    test('the Cloud page id is remembered so the id lookup happens once', async () => {
        const page = makePage({ kind: SOURCE.CLOUD });

        await fetchSnapshot(page);

        expect(page.externalId).toBe('cloud-page-id');
        expect(page.saves).toBe(1);
    });

    test('an unchanged page id is not written again every cycle', async () => {
        const page = makePage({ kind: SOURCE.CLOUD, externalId: 'cloud-page-id' });

        await fetchSnapshot(page);

        expect(page.saves).toBe(0);
    });
});

describe('recovering a closed alert', () => {
    // Several subscriptions watch the same page and every one of them notices the same alert
    // disappear in the same cycle. Without a memo that is one detail request per subscription,
    // every fifteen seconds, for three days.
    test('concurrent callers share a single request', async () => {
        const page = makePage({ kind: SOURCE.CLOUD });

        const [a, b, c] = await Promise.all([
            fetchClosedAlert(page, 'inc-1'),
            fetchClosedAlert(page, 'inc-1'),
            fetchClosedAlert(page, 'inc-1'),
        ]);

        expect(cloud.closedCalls).toBe(1);
        expect(a).toBe(b);
        expect(b).toBe(c);
    });

    test('a different alert is fetched separately', async () => {
        const page = makePage({ kind: SOURCE.CLOUD });

        await Promise.all([fetchClosedAlert(page, 'inc-1'), fetchClosedAlert(page, 'inc-2')]);

        expect(cloud.closedCalls).toBe(2);
    });

    test('a self-hosted page is never asked at all', async () => {
        // There is no such endpoint, and asking would be a 404 per subscription per cycle.
        await expect(fetchClosedAlert(makePage({ kind: SOURCE.SELF_HOSTED }), 'inc-1')).resolves.toBeNull();
        expect(cloud.closedCalls).toBe(0);
    });

    test('the kind the bot remembered is passed through', async () => {
        // Without it a closed notice comes back shaped like an incident, and a calm advisory
        // turns red days after it was posted.
        await fetchClosedAlert(makePage({ kind: SOURCE.CLOUD }), 'inc-1', 'notice');

        expect(cloud.lastExpectedKind).toBe('notice');
    });

    test('a failed lookup is not remembered', async () => {
        const page = makePage({ kind: SOURCE.CLOUD });
        cloud.closedThrows = true;

        await expect(fetchClosedAlert(page, 'inc-1')).rejects.toThrow('lookup failed');

        cloud.closedThrows = false;
        await fetchClosedAlert(page, 'inc-1');

        expect(cloud.closedCalls).toBe(2);
    });

    test('clearSnapshotCache forgets them too', async () => {
        const page = makePage({ kind: SOURCE.CLOUD });

        await fetchClosedAlert(page, 'inc-1');
        clearSnapshotCache();
        await fetchClosedAlert(page, 'inc-1');

        expect(cloud.closedCalls).toBe(2);
    });
});

describe('the memo cannot grow without bound', () => {
    test('an old entry is evicted once the cap is reached', async () => {
        // A fleet of thousands of pages must not turn this into a leak.
        const { MAX_CACHE_ENTRIES } = await import('../../providers/index.js');
        const cap = MAX_CACHE_ENTRIES ?? 5000;

        for (let i = 0; i < cap + 10; i += 1) {
            await fetchSnapshot(makePage({ id: i, url: `https://p${i}.example`, kind: SOURCE.CLOUD }));
        }

        // The very first page is gone, so asking again is a fresh fetch rather than a hit.
        const before = cloud.calls;
        await fetchSnapshot(makePage({ id: 0, url: 'https://p0.example', kind: SOURCE.CLOUD }));

        expect(cloud.calls).toBe(before + 1);
    }, 60000);
});

describe('one fetch per cycle', () => {
    test('concurrent callers share a single fetch', async () => {
        // handleStatusPage and handleAlerts run in the same Promise.all for the same page.
        // Without this, enabling the Cloud would double every page's request count.
        const page = makePage({ kind: SOURCE.CLOUD });

        await Promise.all([fetchSnapshot(page), fetchSnapshot(page)]);

        expect(cloud.calls).toBe(1);
    });

    test('a Cloud page is fetched ONCE for every language', async () => {
        // /full ships every language in one payload and takes no token, so keying on the
        // locale split one request into one per language. Subscriptions are grouped by
        // (token, locale), so a Cloud page watched in three languages issued three
        // byte-identical requests every cycle — and the bot offers thirteen. That is 52
        // requests a minute for a single page against the shared edge budget this memo
        // exists to protect.
        detect.result = SOURCE.CLOUD;
        const page = makePage({ kind: SOURCE.CLOUD });

        await Promise.all([
            fetchSnapshot(page, { locale: 'de' }),
            fetchSnapshot(page, { locale: 'en' }),
            fetchSnapshot(page, { locale: 'fr' }),
        ]);

        expect(cloud.calls).toBe(1);
    });

    test('a self-hosted page is still fetched per language', async () => {
        // Here the locale is sent as Accept-Language and decides what comes back.
        const page = makePage({ kind: SOURCE.SELF_HOSTED });

        await Promise.all([
            fetchSnapshot(page, { locale: 'de' }),
            fetchSnapshot(page, { locale: 'en' }),
        ]);

        expect(selfHosted.calls).toBe(2);
    });

    test('a self-hosted page is still fetched per token', async () => {
        // And here the token decides what the caller is allowed to see. Sharing across tokens
        // would serve one subscription's private page to another.
        const page = makePage({ kind: SOURCE.SELF_HOSTED });

        await Promise.all([
            fetchSnapshot(page, { token: 'token-a', locale: 'de' }),
            fetchSnapshot(page, { token: 'token-b', locale: 'de' }),
        ]);

        expect(selfHosted.calls).toBe(2);
    });

    test('different locales are fetched separately', async () => {
        const page = makePage({ kind: SOURCE.SELF_HOSTED });

        await Promise.all([
            fetchSnapshot(page, { locale: 'de' }),
            fetchSnapshot(page, { locale: 'en' }),
        ]);

        expect(selfHosted.calls).toBe(2);
    });

    test('different API tokens are fetched separately', async () => {
        // The token decides WHAT the page returns; sharing across tokens would leak a private
        // page's contents into a subscription that has no token.
        const page = makePage({ kind: SOURCE.SELF_HOSTED });

        await Promise.all([
            fetchSnapshot(page, { token: null }),
            fetchSnapshot(page, { token: 'secret' }),
        ]);

        expect(selfHosted.calls).toBe(2);
    });

    test('a failed fetch is not cached', async () => {
        // The next cycle must retry; when it retries is the backoff's decision, not a cache's.
        detect.result = null;
        const page = makePage();

        await expect(fetchSnapshot(page)).rejects.toThrow();
        await expect(fetchSnapshot(page)).rejects.toThrow();

        expect(detect.calls).toBe(2);
    });

    test('a new cycle fetches again', async () => {
        const page = makePage({ kind: SOURCE.CLOUD });

        await fetchSnapshot(page);
        clearSnapshotCache();
        await fetchSnapshot(page);

        expect(cloud.calls).toBe(2);
    });
});
