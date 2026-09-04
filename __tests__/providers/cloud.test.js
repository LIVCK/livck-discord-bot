import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { flattenTree, normalizeStatus, splitUpdates, toSnapshot } from '../../providers/cloud.js';
import { ALERT_KIND, BODY_FORMAT, SOURCE, STATUS, resolveText } from '../../dto/statuspage.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

const STATUSPAGE = { url: 'https://status.example.com', name: 'Example' };

const group = (id, name, children, extra = {}) => ({
    id, name, description: null, status: STATUS.OPERATIONAL,
    is_visible: true, is_group: true, children, ...extra,
});
const leaf = (id, name, status = STATUS.OPERATIONAL, extra = {}) => ({
    id, name, description: null, status,
    is_visible: true, is_group: false, children: [], ...extra,
});

describe('normalizeStatus', () => {
    test.each([
        STATUS.OPERATIONAL, STATUS.DEGRADED, STATUS.PARTIAL_OUTAGE,
        STATUS.MAJOR_OUTAGE, STATUS.UNDER_MAINTENANCE, STATUS.UNKNOWN,
    ])('%s passes through', (status) => {
        expect(normalizeStatus(status)).toBe(status);
    });

    test('an unrecognised value becomes unknown, never operational', () => {
        // Assuming "up" for a state we do not understand would show a page as healthy that
        // may not be.
        expect(normalizeStatus('brand_new_state')).toBe(STATUS.UNKNOWN);
        expect(normalizeStatus(undefined)).toBe(STATUS.UNKNOWN);
    });
});

describe('flattenTree', () => {
    test('a top-level group becomes one group with its direct leaves', () => {
        const groups = flattenTree([group('g1', 'Web', [leaf('s1', 'Website'), leaf('s2', 'API')])]);

        expect(groups).toHaveLength(1);
        expect(groups[0].services).toHaveLength(2);
        expect(groups[0].services.every((s) => s.path.length === 0)).toBe(true);
    });

    test('deep nesting collapses onto the top-level group, with the path preserved', () => {
        // Five levels is the Cloud's maximum (config/livck.php max_component_depth). Discord
        // has two structural levels, so the rest has to survive as data for the renderer.
        const tree = [group('eu', 'EU Central', [
            group('ffm', 'Frankfurt', [
                group('dc14', 'DC14', [
                    group('hyp', 'Hypervisors', [
                        leaf('vm1', 'VM-Host-01'),
                        leaf('vm2', 'VM-Host-02', STATUS.DEGRADED),
                    ]),
                ]),
            ]),
        ])];

        const groups = flattenTree(tree);

        expect(groups).toHaveLength(1);
        expect(groups[0].services).toHaveLength(2);
        expect(groups[0].services[0].path).toEqual(['Frankfurt', 'DC14', 'Hypervisors']);
    });

    test('leaves at the root are collected rather than dropped', () => {
        const groups = flattenTree([group('g', 'Web', [leaf('s', 'Site')]), leaf('d', 'Domains')]);

        const synthetic = groups.find((g) => g.id === '__ungrouped__');
        expect(synthetic).toBeDefined();
        expect(synthetic.services.map((s) => s.name)).toEqual(['Domains']);
    });

    test('the synthetic group carries a translation key, not a resolved name', () => {
        // One snapshot serves subscriptions in different languages; a string resolved here
        // would show German in an English channel.
        const groups = flattenTree([leaf('d', 'Domains')]);
        const synthetic = groups.find((g) => g.id === '__ungrouped__');

        expect(synthetic.name).toBeNull();
        expect(synthetic.labelKey).toBe('messages.status.ungrouped');
    });

    test('invisible nodes and subtrees are excluded', () => {
        const tree = [
            group('g1', 'Visible', [leaf('s1', 'Shown'), leaf('s2', 'Hidden', STATUS.MAJOR_OUTAGE, { is_visible: false })]),
            group('g2', 'Invisible', [leaf('s3', 'Also hidden')], { is_visible: false }),
        ];

        const groups = flattenTree(tree);

        expect(groups).toHaveLength(1);
        expect(groups[0].services.map((s) => s.name)).toEqual(['Shown']);
    });

    test('a group that hides its healthy children keeps the counts', () => {
        // Real shape, from status.emeraldhost.de: 66 of 66 children hidden while all healthy.
        const groups = flattenTree([group('g', 'Gameserver', [], {
            hide_operational_children: true, children_total: 66, children_hidden: 66,
        })]);

        expect(groups[0].services).toEqual([]);
        expect(groups[0].childrenTotal).toBe(66);
        expect(groups[0].childrenHidden).toBe(66);
    });

    test('a self-hosted-style group without those fields reports null, not zero', () => {
        // null means "the source does not hide anything"; 0 would mean "hides nothing right
        // now", and the renderer treats the two differently.
        const groups = flattenTree([group('g', 'Web', [leaf('s', 'Site')])]);
        expect(groups[0].childrenTotal).toBeNull();
    });

    test('an empty tree yields no groups', () => {
        expect(flattenTree([])).toEqual([]);
        expect(flattenTree()).toEqual([]);
    });
});

describe('splitUpdates', () => {
    const updates = [
        { id: 'u3', status: 'resolved', message: 'Fixed', created_at: '2026-01-01T03:00:00Z' },
        { id: 'u2', status: 'identified', message: 'Found it', created_at: '2026-01-01T02:00:00Z' },
        { id: 'u1', status: 'investigating', message: 'Looking into it', created_at: '2026-01-01T01:00:00Z' },
    ];

    test('the oldest update is the announcement body', () => {
        // A Cloud incident has no body of its own; the opening update is it.
        expect(splitUpdates(updates).body).toBe('Looking into it');
    });

    test('the remaining updates are chronological', () => {
        expect(splitUpdates(updates).updates.map((u) => u.id)).toEqual(['u2', 'u3']);
    });

    test('the update state is carried across', () => {
        expect(splitUpdates(updates).updates.at(-1).state).toBe('resolved');
    });

    test('an empty timeline yields a null body, not a crash', () => {
        // Happens when every update on a fresh incident is internal-only.
        expect(splitUpdates([])).toEqual({ body: null, updates: [] });
        expect(splitUpdates()).toEqual({ body: null, updates: [] });
    });

    test('a single update becomes the body with no follow-ups', () => {
        const result = splitUpdates([updates[2]]);
        expect(result.body).toBe('Looking into it');
        expect(result.updates).toEqual([]);
    });
});

describe('toSnapshot against recorded payloads', () => {
    test('cloud.statuspage.de renders four groups and sixteen services', () => {
        const snapshot = toSnapshot(load('cloud.full.json'), { url: 'https://cloud.statuspage.de', name: 'x' });

        expect(snapshot.source).toBe(SOURCE.CLOUD);
        expect(snapshot.groups).toHaveLength(4);
        expect(snapshot.groups.reduce((n, g) => n + g.services.length, 0)).toBe(16);
        expect(snapshot.locales).toEqual(['de', 'en']);
        expect(snapshot.defaultLocale).toBe('de');
    });

    test('the computed indicator matches that page own status.json', () => {
        const snapshot = toSnapshot(load('cloud.full.json'), { url: 'https://cloud.statuspage.de', name: 'x' });
        expect(snapshot.overall).toBe(load('cloud.status.json').status.indicator);
    });

    test('status.emeraldhost.de keeps its hidden-children counts and its root leaf', () => {
        const snapshot = toSnapshot(load('emeraldhost.full.json'), { url: 'https://status.emeraldhost.de', name: 'x' });

        const gameserver = snapshot.groups.find((g) => resolveText(g.name, 'de') === 'Gameserver');
        expect(gameserver.services).toEqual([]);
        expect(gameserver.childrenTotal).toBe(66);

        const synthetic = snapshot.groups.find((g) => g.id === '__ungrouped__');
        expect(resolveText(synthetic.services[0].name, 'de')).toBe('Domains');
    });

    test('names stay unresolved so one fetch serves both languages', () => {
        const snapshot = toSnapshot(load('emeraldhost.full.json'), { url: 'https://status.emeraldhost.de', name: 'x' });
        const service = snapshot.groups[0].services[0];

        expect(resolveText(service.name, 'de', 'de')).toBe('EmeraldHost Webseite');
        expect(resolveText(service.name, 'en', 'de')).toBe('EmeraldHost Website');
    });

    test('a server-supplied indicator is preferred over the transcribed fold', () => {
        // The purpose-built public route is expected to carry one; then the local fold
        // becomes a fallback rather than the source of truth.
        const payload = { ...load('cloud.full.json'), status: { indicator: 'degraded' } };
        expect(toSnapshot(payload, STATUSPAGE).overall).toBe('degraded');
    });

    test('a payload missing every optional section does not throw', () => {
        const snapshot = toSnapshot({ meta: {}, components: [] }, STATUSPAGE);
        expect(snapshot.groups).toEqual([]);
        expect(snapshot.alerts).toEqual([]);
        expect(snapshot.overall).toBe(STATUS.UNKNOWN);
    });
});

describe('alerts', () => {
    const payload = (extra) => toSnapshot({
        meta: { default_locale: 'de', supported_locales: ['de'] },
        components: [],
        active_incidents: [],
        notices: [],
        maintenances: { active: [], scheduled: [] },
        ...extra,
    }, STATUSPAGE);

    test('an incident keeps severity, state and a constructed link', () => {
        const [alert] = payload({
            active_incidents: [{
                id: 'inc1', title: { de: 'Störung' }, severity: 'major', status: 'monitoring',
                started_at: '2026-01-01T00:00:00Z', resolved_at: null,
                updates: [{ id: 'u1', status: 'investigating', message: { de: 'Start' }, created_at: '2026-01-01T00:00:00Z' }],
                affected_components: [{ id: 'c1', name: { de: 'API' }, status: 'major_outage' }],
            }],
        }).alerts;

        expect(alert.kind).toBe(ALERT_KIND.INCIDENT);
        expect(alert.severity).toBe('major');
        expect(alert.state).toBe('monitoring');
        expect(alert.format).toBe(BODY_FORMAT.MARKDOWN);
        expect(alert.url).toBe('https://status.example.com/incidents/inc1');
        expect(alert.components).toEqual([{ id: 'c1', name: { de: 'API' }, status: STATUS.MAJOR_OUTAGE }]);
    });

    test('a notice carries neither severity nor state', () => {
        // The Cloud is explicit that a notice makes no claim about the platform. Dropping the
        // fields makes "colour it like an outage" unrepresentable rather than forbidden.
        const [alert] = payload({
            notices: [{
                id: 'n1', title: { de: 'Phishing-Warnung' }, started_at: '2024-07-05T09:00:00Z',
                updates: [{ id: 'nu1', message: { de: 'Wir fragen nie nach Passwörtern.' }, created_at: '2024-07-05T09:00:00Z' }],
                affected_components: [],
            }],
        }).alerts;

        expect(alert.kind).toBe(ALERT_KIND.NOTICE);
        expect(alert.severity).toBeNull();
        expect(alert.state).toBeNull();
        expect(alert.url).toBe('https://status.example.com/incidents/n1');
    });

    test('a maintenance window carries its start and end', () => {
        const [alert] = payload({
            maintenances: {
                active: [{
                    id: 'm1', title: { de: 'Datenbank-Upgrade' }, status: 'in_progress',
                    started_at: '2026-01-01T10:00:00Z',
                    scheduled_start: '2026-01-01T10:00:00Z', scheduled_end: '2026-01-01T12:00:00Z',
                    updates: [], affected_components: [],
                }],
                scheduled: [],
            },
        }).alerts;

        expect(alert.kind).toBe(ALERT_KIND.MAINTENANCE);
        expect(alert.window).toEqual({ start: '2026-01-01T10:00:00Z', end: '2026-01-01T12:00:00Z' });
        expect(alert.url).toBe('https://status.example.com/maintenances/m1');
    });

    test('an open-ended window keeps a null end rather than inventing "now"', () => {
        const [alert] = payload({
            maintenances: {
                active: [{
                    id: 'm2', title: { de: 'Offen' }, status: 'in_progress',
                    scheduled_start: '2026-01-01T10:00:00Z', scheduled_end: null,
                    updates: [], affected_components: [],
                }],
                scheduled: [],
            },
        }).alerts;

        expect(alert.window.end).toBeNull();
        expect(alert.endedAt).toBeNull();
    });

    test('incidents, maintenances and notices land in one ordered list', () => {
        const snapshot = payload({
            active_incidents: [{ id: 'i', title: {}, severity: 'minor', status: 'investigating', started_at: 'x', updates: [], affected_components: [] }],
            notices: [{ id: 'n', title: {}, started_at: 'x', updates: [], affected_components: [] }],
            maintenances: {
                active: [{ id: 'ma', title: {}, status: 'in_progress', scheduled_start: 'x', scheduled_end: null, updates: [], affected_components: [] }],
                scheduled: [{ id: 'ms', title: {}, status: 'scheduled', scheduled_start: 'x', scheduled_end: null, updates: [], affected_components: [] }],
            },
        });

        expect(snapshot.alerts.map((a) => a.id)).toEqual(['i', 'ma', 'ms', 'n']);
        expect(snapshot.alerts.map((a) => a.kind)).toEqual([
            ALERT_KIND.INCIDENT, ALERT_KIND.MAINTENANCE, ALERT_KIND.MAINTENANCE, ALERT_KIND.NOTICE,
        ]);
    });

    test('an active maintenance rescues an otherwise calm page', () => {
        const snapshot = payload({
            components: [{ id: 'c', name: {}, status: STATUS.OPERATIONAL, is_visible: true, is_group: false, children: [] }],
            maintenances: {
                active: [{ id: 'm', title: {}, status: 'in_progress', scheduled_start: 'x', scheduled_end: null, updates: [], affected_components: [] }],
                scheduled: [],
            },
        });

        expect(snapshot.overall).toBe(STATUS.MAINTENANCE);
    });
});
