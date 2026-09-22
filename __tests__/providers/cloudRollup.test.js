/**
 * The transcribed page rollup.
 *
 * The truth table below is the same one the Cloud pins on its side (Laravel's Pest rollup
 * tests and the Edge's overall-status.test.ts). Its live counterpart —
 * cloudRollup.live.test.js — folds a real page and compares against that page's own
 * /status.json, which is the check that catches drift rather than restating it.
 */

import { STATUS } from '../../dto/statuspage.js';
import { applyIncidentFloor, applyMaintenanceRescue, foldGroup, foldPageStatus } from '../../providers/cloudRollup.js';

const { OPERATIONAL, DEGRADED, PARTIAL_OUTAGE, MAJOR_OUTAGE, UNDER_MAINTENANCE, UNKNOWN, MAINTENANCE } = STATUS;

describe('foldGroup', () => {
    test('an empty set is unknown, never fail-green', () => {
        expect(foldGroup([])).toBe(UNKNOWN);
        expect(foldGroup(null)).toBe(UNKNOWN);
    });

    test('all operational stays operational', () => {
        expect(foldGroup([OPERATIONAL, OPERATIONAL])).toBe(OPERATIONAL);
    });

    test('all unknown is unknown ("data delayed")', () => {
        expect(foldGroup([UNKNOWN, UNKNOWN])).toBe(UNKNOWN);
    });

    test('all major collapses to major', () => {
        expect(foldGroup([MAJOR_OUTAGE, MAJOR_OUTAGE])).toBe(MAJOR_OUTAGE);
    });

    test('one healthy sibling breaks the major collapse', () => {
        expect(foldGroup([MAJOR_OUTAGE, OPERATIONAL])).toBe(PARTIAL_OUTAGE);
    });

    test('an unknown sibling also breaks it', () => {
        expect(foldGroup([MAJOR_OUTAGE, UNKNOWN])).toBe(PARTIAL_OUTAGE);
    });

    test('a maintained sibling breaks it too', () => {
        // Deliberate: excluding maintained nodes here would let STARTING a maintenance window
        // escalate a partial outage into a major one.
        expect(foldGroup([MAJOR_OUTAGE, UNDER_MAINTENANCE])).toBe(PARTIAL_OUTAGE);
    });

    test('degraded is not overstated as a partial outage', () => {
        expect(foldGroup([DEGRADED, OPERATIONAL])).toBe(DEGRADED);
        expect(foldGroup([DEGRADED, DEGRADED])).toBe(DEGRADED);
    });

    test('a partial outage outranks a degradation', () => {
        expect(foldGroup([DEGRADED, PARTIAL_OUTAGE])).toBe(PARTIAL_OUTAGE);
    });

    test('nothing worse than maintenance reads as maintenance', () => {
        expect(foldGroup([UNDER_MAINTENANCE, OPERATIONAL])).toBe(UNDER_MAINTENANCE);
    });

    test('unknown never invents an outage', () => {
        expect(foldGroup([UNKNOWN, OPERATIONAL])).toBe(OPERATIONAL);
    });

    test('an unrecognised status is treated as a failure, not waved through', () => {
        // Rule (e) compares against the three neutral values literally rather than by
        // severity, so a status the bot has never heard of counts as something being wrong.
        // That is the fail-safe direction and matches the Edge exactly. In practice the Cloud
        // adapter normalizes unknown values to `unknown` before they ever reach this fold —
        // see providers/cloud.js normalizeStatus.
        expect(foldGroup(['something_new', OPERATIONAL])).toBe(PARTIAL_OUTAGE);
    });
});

describe('applyIncidentFloor', () => {
    test('no incidents changes nothing', () => {
        expect(applyIncidentFloor(OPERATIONAL, [])).toBe(OPERATIONAL);
    });

    test('a critical incident with no linked components still moves the page', () => {
        // The case this rule exists for: a power failure or a fire, where nobody tags fifty
        // services one by one, used to leave "all systems operational" above a critical
        // incident.
        expect(applyIncidentFloor(OPERATIONAL, [{ severity: 'critical' }])).toBe(MAJOR_OUTAGE);
    });

    test.each([
        ['critical', MAJOR_OUTAGE],
        ['major', PARTIAL_OUTAGE],
        ['minor', DEGRADED],
    ])('%s claims %s', (severity, expected) => {
        expect(applyIncidentFloor(OPERATIONAL, [{ severity }])).toBe(expected);
    });

    test('an unknown severity claims the mildest step', () => {
        expect(applyIncidentFloor(OPERATIONAL, [{ severity: 'whatever' }])).toBe(DEGRADED);
        expect(applyIncidentFloor(OPERATIONAL, [{}])).toBe(DEGRADED);
    });

    test('an incident can raise the floor but never lower the components verdict', () => {
        expect(applyIncidentFloor(MAJOR_OUTAGE, [{ severity: 'minor' }])).toBe(MAJOR_OUTAGE);
    });

    test('the worst incident wins', () => {
        expect(applyIncidentFloor(OPERATIONAL, [{ severity: 'minor' }, { severity: 'critical' }]))
            .toBe(MAJOR_OUTAGE);
    });
});

describe('applyMaintenanceRescue', () => {
    test('rescues an otherwise healthy page', () => {
        expect(applyMaintenanceRescue(OPERATIONAL, true)).toBe(MAINTENANCE);
        expect(applyMaintenanceRescue(UNKNOWN, true)).toBe(MAINTENANCE);
    });

    test('never masks a real problem', () => {
        expect(applyMaintenanceRescue(MAJOR_OUTAGE, true)).toBe(MAJOR_OUTAGE);
        expect(applyMaintenanceRescue(DEGRADED, true)).toBe(DEGRADED);
        expect(applyMaintenanceRescue(PARTIAL_OUTAGE, true)).toBe(PARTIAL_OUTAGE);
    });

    test('does nothing without an active window', () => {
        expect(applyMaintenanceRescue(OPERATIONAL, false)).toBe(OPERATIONAL);
    });
});

describe('foldPageStatus', () => {
    const node = (status, extra = {}) => ({ status, is_visible: true, ...extra });

    test('folds top-level nodes only, never the flattened tree', () => {
        // Counting a group AND its children would double-weight the group.
        const tree = [
            node(PARTIAL_OUTAGE, {
                is_group: true,
                children: [node(MAJOR_OUTAGE), node(OPERATIONAL)],
            }),
        ];

        expect(foldPageStatus(tree)).toBe(PARTIAL_OUTAGE);
    });

    test('an invisible top-level node is excluded with its whole subtree', () => {
        const tree = [node(OPERATIONAL), { status: MAJOR_OUTAGE, is_visible: false }];
        expect(foldPageStatus(tree)).toBe(OPERATIONAL);
    });

    test('components, then the incident floor, then the maintenance rescue', () => {
        // A calm page with an active window and no incident is "maintenance"…
        expect(foldPageStatus([node(OPERATIONAL)], [], true)).toBe(MAINTENANCE);
        // …but an incident is the loudest thing a page can say, so the rescue never sees it.
        expect(foldPageStatus([node(OPERATIONAL)], [{ severity: 'major' }], true)).toBe(PARTIAL_OUTAGE);
    });

    test('an empty page is unknown', () => {
        expect(foldPageStatus([])).toBe(UNKNOWN);
    });
});
