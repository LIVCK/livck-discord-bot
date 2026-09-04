import { toSnapshot, groupStatus, overallStatus, mapServiceState } from '../../providers/selfHosted.js';
import { ALERT_KIND, BODY_FORMAT, SOURCE, STATUS, makeService } from '../../dto/statuspage.js';

const STATUSPAGE = { name: 'status.example.com', url: 'https://status.example.com' };

const svc = (status) => makeService({ id: Math.random().toString(), name: 'x', status });

/**
 * The rollup rules were transcribed from messages/layoutRenderers.js, not replaced. These are
 * the ORIGINAL implementations, kept here verbatim so any drift shows up as a failing test
 * rather than as a colour change in thousands of live status messages.
 */
const legacyCategoryStatus = (monitors) => {
    if (!monitors || monitors.length === 0) return 'AVAILABLE';
    const hasUnavailable = monitors.some((m) => m.state === 'UNAVAILABLE');
    const allAvailable = monitors.every((m) => m.state === 'AVAILABLE');
    if (allAvailable) return 'AVAILABLE';
    if (hasUnavailable) return 'UNAVAILABLE';
    return 'DEGRADED';
};

const legacyOverallStatus = (categories) => {
    if (!categories || categories.length === 0) return 'AVAILABLE';
    const all = categories.reduce((acc, cat) => acc.concat(Array.isArray(cat.monitors) ? cat.monitors : []), []);
    if (all.length === 0) return 'AVAILABLE';
    const available = all.filter((m) => m.state === 'AVAILABLE').length;
    if (available === all.length) return 'AVAILABLE';
    if (available === 0) return 'UNAVAILABLE';
    return 'DEGRADED';
};

const LEGACY_TO_DTO = {
    AVAILABLE: STATUS.OPERATIONAL,
    UNAVAILABLE: STATUS.MAJOR_OUTAGE,
    DEGRADED: STATUS.DEGRADED,
};

describe('mapServiceState', () => {
    test.each([
        ['AVAILABLE', STATUS.OPERATIONAL],
        ['UNAVAILABLE', STATUS.MAJOR_OUTAGE],
        ['DEGRADED', STATUS.DEGRADED],
        ['MAINTENANCE', STATUS.UNDER_MAINTENANCE],
    ])('%s maps to %s', (state, expected) => {
        expect(mapServiceState(state)).toBe(expected);
    });

    test('an unrecognised state is unknown, never silently operational', () => {
        // Guessing "up" for a state we do not understand would show a page as healthy that
        // may not be.
        expect(mapServiceState('SOMETHING_NEW')).toBe(STATUS.UNKNOWN);
        expect(mapServiceState(undefined)).toBe(STATUS.UNKNOWN);
    });
});

describe('rollup parity with the pre-DTO implementation', () => {
    const STATES = ['AVAILABLE', 'UNAVAILABLE', 'DEGRADED'];

    /** Every monitor combination up to length three. */
    const combinations = () => {
        const out = [[]];
        for (const a of STATES) {
            out.push([a]);
            for (const b of STATES) {
                out.push([a, b]);
                for (const c of STATES) out.push([a, b, c]);
            }
        }
        return out;
    };

    test.each(combinations().map((states) => [states.join('|') || '(empty)', states]))(
        'group status matches the old rules for %s',
        (_label, states) => {
            const monitors = states.map((state) => ({ state }));
            const services = states.map((state) => svc(mapServiceState(state)));

            expect(groupStatus(services)).toBe(LEGACY_TO_DTO[legacyCategoryStatus(monitors)]);
        }
    );

    test.each(combinations().map((states) => [states.join('|') || '(empty)', states]))(
        'overall status matches the old rules for %s',
        (_label, states) => {
            const monitors = states.map((state) => ({ state }));
            const categories = [{ monitors }];
            const groups = [{ services: states.map((state) => svc(mapServiceState(state))) }];

            expect(overallStatus(groups)).toBe(LEGACY_TO_DTO[legacyOverallStatus(categories)]);
        }
    );

    test('overall folds over services, not over group statuses', () => {
        // Two groups, one fully down and one fully up: folding group statuses would give
        // "one of two groups broken", but the old code counted MONITORS and returned degraded.
        const groups = [
            { services: [svc(STATUS.MAJOR_OUTAGE)] },
            { services: [svc(STATUS.OPERATIONAL)] },
        ];
        expect(overallStatus(groups)).toBe(STATUS.DEGRADED);
    });

    test('an empty page counts as operational, as it always has', () => {
        expect(overallStatus([])).toBe(STATUS.OPERATIONAL);
        expect(groupStatus([])).toBe(STATUS.OPERATIONAL);
    });
});

describe('toSnapshot', () => {
    const service = () => ({
        categories: [{
            id: 'cat-1',
            name: 'Platform',
            short_description: 'Core',
            monitors: [
                { id: 'm1', name: 'API', state: 'AVAILABLE', short_description: 'https://api' },
                { id: 'm2', name: 'Web', state: 'UNAVAILABLE', short_description: null },
            ],
        }],
        alerts: [],
    });

    test('marks its source', () => {
        expect(toSnapshot(service(), STATUSPAGE).source).toBe(SOURCE.SELF_HOSTED);
    });

    test('categories become depth-zero groups', () => {
        const [group] = toSnapshot(service(), STATUSPAGE).groups;

        expect(group.id).toBe('cat-1');
        expect(group.depth).toBe(0);
        expect(group.path).toEqual([]);
        expect(group.services).toHaveLength(2);
        expect(group.status).toBe(STATUS.MAJOR_OUTAGE);
    });

    test('a monitor short_description becomes the service description', () => {
        const [group] = toSnapshot(service(), STATUSPAGE).groups;
        expect(group.services[0].description).toBe('https://api');
        expect(group.services[1].description).toBeNull();
    });

    test('a category with a non-array monitors field does not throw', () => {
        const broken = { categories: [{ id: 'c', name: 'X', monitors: null }] };
        expect(() => toSnapshot(broken, STATUSPAGE)).not.toThrow();
        expect(toSnapshot(broken, STATUSPAGE).groups[0].services).toEqual([]);
    });

    test('a missing categories key yields an empty, operational page', () => {
        const snapshot = toSnapshot({}, STATUSPAGE);
        expect(snapshot.groups).toEqual([]);
        expect(snapshot.overall).toBe(STATUS.OPERATIONAL);
    });
});

describe('alert mapping', () => {
    const alertOf = (overrides) => toSnapshot({
        categories: [],
        alerts: [{
            id: 'a1',
            title: 'Störung',
            message: '<p>Text</p>',
            type: 'INCIDENT',
            state: 'OPEN',
            link: 'https://status.example.com/alert/a',
            created_at: '2026-01-01T00:00:00Z',
            alerts: [],
            monitors: [],
            ...overrides,
        }],
    }, STATUSPAGE).alerts[0];

    test('an INCIDENT is an incident', () => {
        expect(alertOf({}).kind).toBe(ALERT_KIND.INCIDENT);
    });

    test('a scheduled item is a maintenance window with its times', () => {
        const alert = alertOf({
            type: 'MAINTENANCE',
            scheduled_for: '2026-02-01T10:00:00Z',
            scheduled_until: '2026-02-01T12:00:00Z',
        });

        expect(alert.kind).toBe(ALERT_KIND.MAINTENANCE);
        expect(alert.window).toEqual({ start: '2026-02-01T10:00:00Z', end: '2026-02-01T12:00:00Z' });
    });

    test('an open-ended window keeps a null end', () => {
        const alert = alertOf({ type: 'MAINTENANCE', scheduled_for: '2026-02-01T10:00:00Z' });
        expect(alert.window.end).toBeNull();
    });

    test('anything else is a notice and carries no severity', () => {
        const alert = alertOf({ type: 'INFORMATION' });
        expect(alert.kind).toBe(ALERT_KIND.NOTICE);
        expect(alert.severity).toBeNull();
    });

    test('the body is flagged as HTML so the renderer converts it', () => {
        expect(alertOf({}).format).toBe(BODY_FORMAT.HTML);
    });

    test('sub-alerts become the update timeline', () => {
        const alert = alertOf({
            alerts: [
                { id: 'u1', message: '<p>Erstes Update</p>', state: 'OPEN', created_at: '2026-01-01T01:00:00Z' },
                { id: 'u2', message: '<p>Behoben</p>', state: 'RESOLVED', created_at: '2026-01-01T02:00:00Z' },
            ],
        });

        expect(alert.updates.map((u) => u.id)).toEqual(['u1', 'u2']);
        expect(alert.updates[1].state).toBe('RESOLVED');
    });

    test('affected monitors are carried across', () => {
        const alert = alertOf({ monitors: [{ id: 'm1', name: 'Phone Support', slug: 'phone' }] });
        expect(alert.components).toEqual([{ id: 'm1', name: 'Phone Support', status: null }]);
    });
});
