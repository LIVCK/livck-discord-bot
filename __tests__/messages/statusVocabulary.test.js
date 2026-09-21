/**
 * Every value the data layer can produce is actually rendered by something.
 *
 * The question this answers is "is the payload space covered", and it used to be answered by
 * counting tests rather than by checking. It was not: the payload factory said
 * `degraded_performance`, which is Atlassian's spelling and not a member of LIVCK's
 * `ComponentStatus` enum, so the adapter mapped every one of those to `unknown`. The status a
 * busy page shows most often had never once been rendered, and the scenario named
 * `cloud-03-degraded-only` contained no degraded component at all.
 *
 * Counting could not have found that. Comparing the vocabulary against what the corpus
 * actually produces does, and fails the day either side moves.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { KNOWN_STATUSES, toSnapshot as cloudSnapshot } from '../../providers/cloud.js';
import { toSnapshot as selfHostedSnapshot, mapServiceState } from '../../providers/selfHosted.js';
import Statuspage from '../../services/statuspage.js';
import { STATUS } from '../../dto/statuspage.js';
import { CLOUD_STATUSES, SELF_HOSTED_STATES } from '../fixtures/payloadFactory.js';
import { getLayoutRenderer } from '../../messages/layoutRenderers.js';
import { getStatusDot } from '../../config/emojis.js';

const CORPUS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/corpus');
const PAGE = { url: 'https://vocab.example', name: 'vocab' };

const snapshots = fs.readdirSync(CORPUS).filter((f) => f.endsWith('.json')).map((file) => {
    const payload = JSON.parse(fs.readFileSync(path.join(CORPUS, file), 'utf8'));

    return file.startsWith('selfhosted-')
        ? selfHostedSnapshot({ categories: Statuspage.normalizeCategories(payload), alerts: [] }, PAGE)
        : cloudSnapshot(payload, PAGE);
});

/**
 * `maintenance` is the PAGE indicator, produced by the rollup when an otherwise healthy page
 * has a window running. A component is never in it — a component says `under_maintenance`.
 */
const PAGE_LEVEL_ONLY = new Set([STATUS.MAINTENANCE]);

describe('the factory speaks the adapter language', () => {
    test('its Cloud statuses are exactly the ones the adapter accepts', () => {
        // Retyped, this list said `degraded_performance` for months of work.
        expect([...CLOUD_STATUSES].sort()).toEqual([...KNOWN_STATUSES].sort());
    });

    test('every self-hosted state it offers is either mapped or deliberately not', () => {
        const mapped = SELF_HOSTED_STATES.filter((state) => mapServiceState(state) !== STATUS.UNKNOWN);
        const unmapped = SELF_HOSTED_STATES.filter((state) => mapServiceState(state) === STATUS.UNKNOWN);

        // The four the adapter knows, and at least one it does not — an unrecognised state
        // must land on `unknown` rather than be assumed healthy.
        expect(mapped.sort()).toEqual(['AVAILABLE', 'DEGRADED', 'MAINTENANCE', 'UNAVAILABLE']);
        expect(unmapped.length).toBeGreaterThan(0);
    });
});

describe('the corpus produces every status', () => {
    const componentStatuses = new Set(snapshots.flatMap(
        (s) => s.groups.flatMap((g) => [g.status, ...g.services.map((x) => x.status)])));
    const overallStatuses = new Set(snapshots.map((s) => s.overall));

    test.each(Object.values(STATUS).filter((v) => !PAGE_LEVEL_ONLY.has(v)))(
        'a component or group somewhere is %s', (status) => {
            expect(componentStatuses.has(status)).toBe(true);
        });

    test.each(Object.values(STATUS))('a page somewhere reads as %s overall', (status) => {
        expect(overallStatuses.has(status)).toBe(true);
    });

    test('and no component ever carries the page-only status', () => {
        // If one did, the rollup and the component vocabulary would have merged by accident.
        for (const status of PAGE_LEVEL_ONLY) expect(componentStatuses.has(status)).toBe(false);
    });
});

describe('a reader can tell the statuses apart', () => {
    const LAYOUTS = ['DETAILED', 'COMPACT', 'OVERVIEW', 'TREE', 'MINIMAL'];

    /** The mark a layout puts in front of a service in this status. */
    const markFor = (layout, status) => {
        const snapshot = {
            source: 'CLOUD', url: 'https://vocab.example', name: { de: 'X' },
            overall: status, defaultLocale: 'de', locales: ['de'], alerts: [],
            groups: [{
                id: 'g', name: { de: 'G' }, status, childrenTotal: null, childrenHidden: null,
                services: [{ id: 's', name: { de: 'Dienst' }, status, path: [] }],
            }],
        };

        const json = getLayoutRenderer(layout)(snapshot, 'de')[0].embed.toJSON();
        const text = `${json.description ?? ''} ${(json.fields ?? []).map((f) => f.value).join(' ')}`
            .replace(/<a?:(\w+):\d+>/g, ':$1:');

        return text.match(/:status_\w+:|\p{Extended_Pictographic}|●/u)?.[0] ?? null;
    };

    test.each(LAYOUTS)('%s gives a healthy service a different mark from a broken one', (layout) => {
        expect(markFor(layout, STATUS.OPERATIONAL)).not.toBe(markFor(layout, STATUS.MAJOR_OUTAGE));
    });

    test.each(LAYOUTS)('%s does not paint a maintenance window as an outage', (layout) => {
        // MINIMAL collapsed everything non-operational to red, so a planned window and a
        // degraded service both read as a total failure — the one direction a status page
        // must never err in.
        expect(markFor(layout, STATUS.UNDER_MAINTENANCE)).not.toBe(markFor(layout, STATUS.MAJOR_OUTAGE));
        expect(markFor(layout, STATUS.DEGRADED)).not.toBe(markFor(layout, STATUS.MAJOR_OUTAGE));
    });

    test.each(LAYOUTS)('%s does not present a maintenance window as "no information"', (layout) => {
        // The default layout put degraded, partial_outage, under_maintenance, unknown and the
        // page-level maintenance all on ❔.
        expect(markFor(layout, STATUS.UNDER_MAINTENANCE)).not.toBe(markFor(layout, STATUS.UNKNOWN));
        expect(markFor(layout, STATUS.DEGRADED)).not.toBe(markFor(layout, STATUS.UNKNOWN));
    });

    test.each(LAYOUTS)('%s distinguishes degraded from a full outage and from healthy', (layout) => {
        const degraded = markFor(layout, STATUS.DEGRADED);

        expect(degraded).not.toBe(markFor(layout, STATUS.OPERATIONAL));
        expect(degraded).not.toBe(markFor(layout, STATUS.MAJOR_OUTAGE));
    });

    test('every layout agrees with every other on what each status looks like', () => {
        // Two of them used a different function from the other three, which is how the
        // vocabulary drifted apart in the first place.
        for (const status of Object.values(STATUS)) {
            const marks = LAYOUTS.map((layout) => markFor(layout, status));
            const custom = marks.filter((m) => m?.startsWith(':status_'));

            // Either every layout shows the same mark, or the difference is exactly the
            // custom animated emoji that only two states have.
            const normalised = new Set(marks.map((m) => (m?.startsWith(':status_') ? 'custom' : m)));
            expect(normalised.size).toBeLessThanOrEqual(2);
            if (normalised.size === 2) expect(custom.length).toBeGreaterThan(0);
        }
    });
});

describe('every status survives the trip to a reader', () => {
    test.each(Object.values(STATUS))('%s has a symbol of its own', (status) => {
        const dot = getStatusDot(status);

        expect(typeof dot).toBe('string');
        expect(dot.length).toBeGreaterThan(0);
    });

    test.each(Object.values(STATUS))('%s renders in every layout without leaking a key', (status) => {
        const snapshot = { ...snapshots[0], overall: status };

        for (const layout of ['DETAILED', 'COMPACT', 'OVERVIEW', 'TREE', 'MINIMAL']) {
            for (const { embed } of getLayoutRenderer(layout)(snapshot, 'de')) {
                const json = embed.toJSON();
                const text = `${json.title}\n${json.description ?? ''}\n${(json.fields ?? []).map((f) => `${f.name}${f.value}`).join('')}`;

                expect(text).not.toMatch(/\bmessages\.[a-z_]+\.[a-z_.]+/);
                expect(text).not.toMatch(/\bundefined\b/);
            }
        }
    });
});
