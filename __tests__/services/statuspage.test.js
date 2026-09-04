import Statuspage from '../../services/statuspage.js';
import { HttpError } from '../../util/errors.js';

describe('normalizeCategories', () => {
    test('accepts the object-keyed-by-UUID shape the v3 API actually returns', () => {
        // /api/v3/categories answers with an object whose keys are category UUIDs, not an
        // array. Anything that assumes an array silently renders an empty status page.
        const response = {
            'ad41a2eb-c52e-4950-a4e3-ccd666a84728': { id: 'ad41a2eb', name: 'Cloud - Platform' },
            'd722bc3e-219c-4bee-9e1a-bc9adf482210': { id: 'd722bc3e', name: 'Cloud - Edge' },
        };

        const result = Statuspage.normalizeCategories(response);

        expect(result).toHaveLength(2);
        expect(result.map((c) => c.name)).toEqual(['Cloud - Platform', 'Cloud - Edge']);
    });

    test('accepts a plain array too', () => {
        const result = Statuspage.normalizeCategories([{ id: 'a', name: 'X' }]);
        expect(result).toEqual([{ id: 'a', name: 'X' }]);
    });

    test('unwraps a data envelope', () => {
        const result = Statuspage.normalizeCategories({ data: [{ id: 'a', name: 'X' }] });
        expect(result).toEqual([{ id: 'a', name: 'X' }]);
    });

    test('an empty data envelope yields no categories', () => {
        expect(Statuspage.normalizeCategories({ data: [] })).toEqual([]);
    });

    test('nullish and scalar responses yield no categories', () => {
        expect(Statuspage.normalizeCategories(null)).toEqual([]);
        expect(Statuspage.normalizeCategories(undefined)).toEqual([]);
        expect(Statuspage.normalizeCategories('nonsense')).toEqual([]);
        expect(Statuspage.normalizeCategories({})).toEqual([]);
    });

    test('drops non-object entries rather than rendering them', () => {
        const result = Statuspage.normalizeCategories({ a: { id: 'a' }, b: null, c: 'x' });
        expect(result).toEqual([{ id: 'a' }]);
    });
});

/** Minimal LIVCK client stand-in. */
const fakeClient = (responses) => ({
    baseURL: 'https://status.example.com',
    get: async (path) => {
        const value = responses[path] ?? responses.default;
        if (value instanceof Error) throw value;
        if (value === undefined) throw new HttpError(404, 'Not Found');
        return value;
    },
});

describe('fetching', () => {
    test('categories are loaded together with their monitors', async () => {
        const service = new Statuspage(fakeClient({
            categories: { c1: { id: 'c1', name: 'Platform' } },
            'category/c1/monitors': { data: [{ id: 'm1', name: 'API', state: 'AVAILABLE' }] },
        }));

        await service.fetchCategories();

        expect(service.categories).toHaveLength(1);
        expect(service.categories[0].monitors).toEqual([{ id: 'm1', name: 'API', state: 'AVAILABLE' }]);
    });

    test('a failing fetch propagates instead of yielding an empty page', async () => {
        // This is the whole point of Phase 0: an unreachable page must look different from
        // an empty one, or the backoff never engages.
        const service = new Statuspage(fakeClient({ categories: new HttpError(503, 'Service Unavailable') }));

        await expect(service.fetchCategories()).rejects.toMatchObject({ status: 503 });
    });

    test('alerts default to an empty list when the payload has none', async () => {
        const service = new Statuspage(fakeClient({ alerts: {} }));
        await expect(service.fetchAlerts()).resolves.toEqual([]);
    });

    test('alerts are read out of the data envelope', async () => {
        const service = new Statuspage(fakeClient({ alerts: { data: [{ id: 'a1', title: 'Outage' }] } }));
        await expect(service.fetchAlerts()).resolves.toEqual([{ id: 'a1', title: 'Outage' }]);
    });

    test('a failing alerts fetch propagates', async () => {
        const service = new Statuspage(fakeClient({ alerts: new HttpError(500, 'Server Error') }));
        await expect(service.fetchAlerts()).rejects.toMatchObject({ status: 500 });
    });
});
