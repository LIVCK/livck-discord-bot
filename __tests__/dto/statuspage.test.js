import {
    DTO_VERSION,
    STATUS,
    SOURCE,
    allServices,
    makeAlert,
    makeGroup,
    makeService,
    makeSnapshot,
    resolveText,
} from '../../dto/statuspage.js';

describe('resolveText', () => {
    test('a plain string passes through — self-hosted renders server-side', () => {
        expect(resolveText('Homepage', 'de')).toBe('Homepage');
    });

    test('the requested locale wins', () => {
        expect(resolveText({ de: 'Allgemein', en: 'General' }, 'de')).toBe('Allgemein');
        expect(resolveText({ de: 'Allgemein', en: 'General' }, 'en')).toBe('General');
    });

    test('falls back to the page default when the locale is missing', () => {
        expect(resolveText({ de: 'Allgemein' }, 'en', 'de')).toBe('Allgemein');
    });

    test('falls back to any usable value when neither is present', () => {
        // A page may offer languages the subscription does not use; showing SOMETHING beats
        // showing an empty field.
        expect(resolveText({ fr: 'Général' }, 'en', 'de')).toBe('Général');
    });

    test('a cleared translation is null on the wire and must not be returned', () => {
        // The console persists a cleared locale as null rather than removing the key.
        expect(resolveText({ de: null, en: 'General' }, 'de', 'de')).toBe('General');
        expect(resolveText({ de: '', en: 'General' }, 'de', 'de')).toBe('General');
    });

    test('the last-resort pick is deterministic, not object-key order', () => {
        const a = resolveText({ zz: 'Z', aa: 'A' }, 'en', 'de');
        const b = resolveText({ aa: 'A', zz: 'Z' }, 'en', 'de');
        expect(a).toBe(b);
        expect(a).toBe('A');
    });

    test('nullish and unusable input yields the fallback', () => {
        expect(resolveText(null, 'de')).toBe('');
        expect(resolveText(undefined, 'de')).toBe('');
        expect(resolveText({}, 'de')).toBe('');
        expect(resolveText({ de: null }, 'de')).toBe('');
        expect(resolveText(42, 'de', 'en', 'n/a')).toBe('n/a');
    });
});

describe('factories', () => {
    const service = makeService({ id: 's1', name: 'API', status: STATUS.OPERATIONAL });

    test('produce frozen objects, so a renderer cannot corrupt shared state', () => {
        // One snapshot is rendered once per subscription; a renderer that mutated it would
        // leak into the next subscription's output.
        expect(Object.isFrozen(service)).toBe(true);
        expect(() => { service.status = STATUS.MAJOR_OUTAGE; }).toThrow();
    });

    test('a group freezes its service list too', () => {
        const group = makeGroup({ id: 'g', name: 'G', status: STATUS.OPERATIONAL, services: [service] });
        expect(Object.isFrozen(group.services)).toBe(true);
        expect(Object.isFrozen(group.path)).toBe(true);
    });

    test('defaults are explicit rather than undefined', () => {
        const group = makeGroup({ id: 'g', name: 'G', status: STATUS.OPERATIONAL });
        expect(group.depth).toBe(0);
        expect(group.path).toEqual([]);
        expect(group.services).toEqual([]);
        expect(group.childrenTotal).toBeNull();
        expect(service.description).toBeNull();
        expect(service.uptime).toBeNull();
    });

    test('a snapshot carries its schema version', () => {
        const snapshot = makeSnapshot({
            source: SOURCE.SELF_HOSTED, url: 'https://x', name: 'X', overall: STATUS.OPERATIONAL,
        });
        expect(snapshot.v).toBe(DTO_VERSION);
    });

    test('an alert keeps its kind and window', () => {
        const alert = makeAlert({
            id: 'a', kind: 'maintenance', url: 'https://x/m/1', title: 'T', format: 'markdown',
            startedAt: '2026-01-01T00:00:00Z', window: { start: '2026-01-01T00:00:00Z', end: null },
        });

        expect(alert.kind).toBe('maintenance');
        expect(alert.window).toEqual({ start: '2026-01-01T00:00:00Z', end: null });
        expect(alert.severity).toBeNull();
        expect(Object.isFrozen(alert.updates)).toBe(true);
    });

    test('an open-ended maintenance keeps a null end rather than inventing one', () => {
        const alert = makeAlert({
            id: 'a', kind: 'maintenance', url: 'u', title: 'T', format: 'markdown',
            startedAt: 'x', window: { start: 'x', end: null },
        });
        expect(alert.window.end).toBeNull();
    });
});

describe('allServices', () => {
    test('flattens every group in display order', () => {
        const snapshot = makeSnapshot({
            source: SOURCE.CLOUD, url: 'u', name: 'n', overall: STATUS.OPERATIONAL,
            groups: [
                makeGroup({ id: 'g1', name: 'A', status: STATUS.OPERATIONAL, services: [
                    makeService({ id: '1', name: 'one', status: STATUS.OPERATIONAL }),
                ] }),
                makeGroup({ id: 'g2', name: 'B', status: STATUS.OPERATIONAL, services: [
                    makeService({ id: '2', name: 'two', status: STATUS.OPERATIONAL }),
                    makeService({ id: '3', name: 'three', status: STATUS.OPERATIONAL }),
                ] }),
            ],
        });

        expect(allServices(snapshot).map((s) => s.id)).toEqual(['1', '2', '3']);
    });
});
