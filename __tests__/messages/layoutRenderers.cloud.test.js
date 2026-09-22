/**
 * Rendering of the things only a Cloud page has: a component tree deeper than one level,
 * groups that hide their healthy children, and locale maps instead of plain strings.
 *
 * The golden test next door proves none of this changed the self-hosted output.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { toSnapshot } from '../../providers/cloud.js';
import { STATUS } from '../../dto/statuspage.js';
import { DISCORD_LIMITS, embedLength } from '../../util/discordLimits.js';
import {
    renderCompactLayout,
    renderDetailedLayout,
    renderMinimalLayout,
    renderOverviewLayout,
    renderTreeLayout,
} from '../../messages/layoutRenderers.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

const EMERALD = { url: 'https://status.emeraldhost.de', name: 'EmeraldHost' };

const group = (id, name, children, extra = {}) => ({
    id, name, description: null, status: STATUS.OPERATIONAL,
    is_visible: true, is_group: true, children, ...extra,
});
const leaf = (id, name, status = STATUS.OPERATIONAL) => ({
    id, name, description: null, status, is_visible: true, is_group: false, children: [],
});

const snapshotOf = (components, extra = {}) => toSnapshot({
    meta: { default_locale: 'de', supported_locales: ['de', 'en'], name: { de: 'Test' } },
    components,
    active_incidents: [],
    notices: [],
    maintenances: { active: [], scheduled: [] },
    ...extra,
}, EMERALD);

const fieldsOf = (result) => result[0].embed.toJSON().fields ?? [];
const descriptionOf = (result) => result[0].embed.toJSON().description ?? '';

describe('hidden healthy children', () => {
    const emerald = () => toSnapshot(load('emeraldhost.full.json'), EMERALD);

    /**
     * The statuspage prints its "N components · M affected" summary only when something IS
     * affected (HorizonComponentItem.vue: `isGroup && collapseOperational && affectedCount > 0`).
     * While a hiding group is healthy it states no number at all — and neither may the bot,
     * or it would disclose a fleet size the operator keeps off their own page.
     */
    test('a quiet hiding group never reveals how many systems are behind it', () => {
        const fields = fieldsOf(renderDetailedLayout(emerald(), 'de'));
        const gameserver = fields.find((f) => f.name === 'Gameserver');

        expect(gameserver.value).not.toContain('66');
        expect(gameserver.value).toContain('Betriebsbereit');
    });

    test('no hidden count leaks into any layout while everything is healthy', () => {
        const snapshot = emerald();
        const counts = ['66', '17'];   // the real hidden totals on that page

        for (const render of [renderDetailedLayout, renderCompactLayout, renderOverviewLayout, renderTreeLayout, renderMinimalLayout]) {
            for (const locale of ['de', 'en']) {
                const json = render(snapshot, locale)[0].embed.toJSON();
                const text = [json.description ?? '', ...(json.fields ?? []).map((f) => `${f.name} ${f.value}`)].join(' ');

                for (const count of counts) {
                    expect(text).not.toContain(count);
                }
            }
        }
    });

    test('the compact tile shows a status instead of a fraction', () => {
        const fields = fieldsOf(renderCompactLayout(emerald(), 'de'));
        const gameserver = fields.find((f) => f.name === 'Gameserver');

        expect(gameserver.value).not.toMatch(/\d+\/\d+/);
        expect(gameserver.value).toContain('Betriebsbereit');
    });

    test('the overview total counts only what the page discloses', () => {
        // 2 visible under "Allgemein" + 1 root leaf; the 86 hidden ones stay uncounted.
        const description = descriptionOf(renderOverviewLayout(emerald(), 'de'));

        expect(description).toContain('3/3');
        expect(description).not.toContain('89');
    });

    test('once something IS affected, the page discloses and so does the bot', () => {
        // At that point the count is on the customer's own status page, so repeating it in
        // Discord reveals nothing new — and the affected node has to be nameable.
        const snapshot = snapshotOf([group('g', { de: 'Nodes' }, [leaf('n1', { de: 'node-01' }, STATUS.MAJOR_OUTAGE)], {
            hide_operational_children: true, children_total: 50, children_hidden: 49,
        })]);

        const [field] = fieldsOf(renderDetailedLayout(snapshot, 'de'));

        expect(field.value).toContain('node-01');
        expect(field.value).toContain('50');
        expect(field.value).toContain('1');
    });

    test('the summary is worded exactly like the statuspage', () => {
        const snapshot = snapshotOf([group('g', { de: 'Nodes' }, [leaf('n1', { de: 'node-01' }, STATUS.MAJOR_OUTAGE)], {
            hide_operational_children: true, children_total: 50, children_hidden: 49,
        })]);

        expect(fieldsOf(renderDetailedLayout(snapshot, 'de'))[0].value).toContain('50 Systeme · 1 betroffen');
        expect(fieldsOf(renderDetailedLayout(snapshot, 'en'))[0].value).toContain('50 components · 1 affected');
    });

    test('the tree layout does not render a hiding group as an empty heading', () => {
        // Found by running the real pipeline against status.emeraldhost.de: four of its six
        // groups appeared as bare headings with nothing underneath, which reads as broken
        // rather than as healthy. The field layouts had the fallback; these two did not.
        const description = descriptionOf(renderTreeLayout(emerald(), 'de'));
        const lines = description.split('\n');
        const heading = lines.findIndex((l) => l.includes('Gameserver') && l.startsWith('**'));

        expect(lines[heading + 1].trim()).not.toBe('');
        expect(lines[heading + 1]).toContain('Betriebsbereit');
        expect(description).not.toContain('66');
    });

    test('the minimal layout does not either', () => {
        const description = descriptionOf(renderMinimalLayout(emerald(), 'de'));
        const lines = description.split('\n');
        const heading = lines.findIndex((l) => l === '**Gameserver**');

        expect(lines[heading + 1].trim()).not.toBe('');
        expect(description).not.toContain('66');
    });

    test('an ordinary empty group gets a line too, not just a hiding one', () => {
        // This test used to pin the opposite, on the reasoning that a genuinely empty category
        // "must keep its previous rendering". That reasoning was wrong: a bold heading with
        // nothing under it reads as broken whether the group is hiding something or not, and
        // an ordinary empty group has no `childrenTotal`, so the guard that was supposed to
        // catch this skipped it. If it is the only category, the entire description was one
        // bold word.
        const snapshot = snapshotOf([group('g', { de: 'Leer' }, [])]);

        const tree = descriptionOf(renderTreeLayout(snapshot, 'de'));
        expect(tree.split('\n')[1].trim()).not.toBe('');

        const minimal = descriptionOf(renderMinimalLayout(snapshot, 'de'));
        expect(minimal.split('\n')[1].trim()).not.toBe('');

        // And still no count, for a group that has nothing to count.
        expect(tree).not.toMatch(/\d+\s*\/\s*\d+/);
    });

    test('a normal group is unaffected by any of this', () => {
        const snapshot = snapshotOf([group('g', { de: 'Web' }, [leaf('s', { de: 'Website' })])]);
        const [field] = fieldsOf(renderDetailedLayout(snapshot, 'de'));

        expect(field.value).toContain('Website');
        expect(field.value).not.toContain('·');
    });
});

describe('nesting deeper than one level', () => {
    const deep = () => snapshotOf([group('eu', { de: 'EU Central' }, [
        group('ffm', { de: 'Frankfurt' }, [
            group('dc14', { de: 'DC14' }, [
                leaf('vm1', { de: 'VM-Host-01' }),
                leaf('vm2', { de: 'VM-Host-02' }, STATUS.MAJOR_OUTAGE),
            ]),
        ]),
        leaf('direct', { de: 'Direkt am Wurzelknoten' }),
    ])]);

    test('a five-level tree still becomes one Discord field', () => {
        // Discord has two structural levels. Making each nested group its own field would
        // spend the 25-field budget on headings.
        expect(fieldsOf(renderDetailedLayout(deep(), 'de'))).toHaveLength(1);
    });

    test('the path survives as a heading inside the field', () => {
        const [field] = fieldsOf(renderDetailedLayout(deep(), 'de'));
        expect(field.value).toContain('Frankfurt / DC14');
        expect(field.value).toContain('VM-Host-01');
    });

    test('a service directly under the top-level group needs no heading', () => {
        const [field] = fieldsOf(renderDetailedLayout(deep(), 'de'));
        const line = field.value.split('\n').find((l) => l.includes('Direkt am Wurzelknoten'));
        expect(line.startsWith('┗━')).toBe(false);
    });

    test('a deep tree still respects every Discord limit', () => {
        const wide = Array.from({ length: 30 }, (_, g) => group(`g${g}`, { de: `Region ${g}` }, [
            group(`s${g}`, { de: `Standort ${g}` }, Array.from({ length: 40 }, (_, i) => leaf(`l${g}-${i}`, { de: `Node ${g}-${i} ${'x'.repeat(30)}` }))),
        ]));

        const [{ embed }] = renderDetailedLayout(snapshotOf(wide), 'de');
        const json = embed.toJSON();

        expect(json.fields.length).toBeLessThanOrEqual(DISCORD_LIMITS.EMBED_FIELDS);
        expect(embedLength(json)).toBeLessThanOrEqual(DISCORD_LIMITS.MESSAGE_EMBED_TOTAL);
        for (const field of json.fields) {
            expect(field.value.length).toBeLessThanOrEqual(DISCORD_LIMITS.EMBED_FIELD_VALUE);
            expect(field.value.length).toBeGreaterThan(0);
        }
    });
});

describe('localisation from a single snapshot', () => {
    const emerald = () => toSnapshot(load('emeraldhost.full.json'), EMERALD);

    test('one snapshot renders correctly in both languages', () => {
        // This is why the DTO keeps locale maps unresolved: one fetch, many subscriptions.
        const snapshot = emerald();

        expect(fieldsOf(renderDetailedLayout(snapshot, 'de'))[0].name).toBe('Allgemein');
        expect(fieldsOf(renderDetailedLayout(snapshot, 'en'))[0].name).toBe('General');
    });

    test('the synthetic group is translated, not baked in at fetch time', () => {
        const snapshot = emerald();

        const de = fieldsOf(renderDetailedLayout(snapshot, 'de')).at(-1).name;
        const en = fieldsOf(renderDetailedLayout(snapshot, 'en')).at(-1).name;

        expect(de).toBe('Weitere Dienste');
        expect(en).toBe('Other services');
    });

    test('a name missing the requested locale falls back to the page default', () => {
        const snapshot = snapshotOf([group('g', { de: 'Nur Deutsch' }, [leaf('s', { de: 'Dienst' })])]);
        expect(fieldsOf(renderDetailedLayout(snapshot, 'en'))[0].name).toBe('Nur Deutsch');
    });
});

describe('the richer status vocabulary', () => {
    const withStatus = (status) => snapshotOf([
        { id: 'c', name: { de: 'Ding' }, description: null, status, is_visible: true, is_group: false, children: [] },
    ]);

    test.each([
        [STATUS.OPERATIONAL, 0x2ecc71],
        [STATUS.MAJOR_OUTAGE, 0xe74c3c],
        [STATUS.DEGRADED, 0xf39c12],
        [STATUS.PARTIAL_OUTAGE, 0xf39c12],
    ])('%s colours the embed 0x%s', (status, expected) => {
        const [{ embed }] = renderDetailedLayout(withStatus(status), 'de');
        expect(embed.toJSON().color).toBe(expected);
    });

    test('a maintenance window colours the page blue rather than red', () => {
        const snapshot = snapshotOf([leaf('c', { de: 'Ding' })], {
            maintenances: {
                active: [{ id: 'm', title: { de: 'W' }, status: 'in_progress', scheduled_start: 'x', scheduled_end: null, updates: [], affected_components: [] }],
                scheduled: [],
            },
        });

        expect(snapshot.overall).toBe(STATUS.MAINTENANCE);
        expect(renderDetailedLayout(snapshot, 'de')[0].embed.toJSON().color).toBe(0x3498db);
    });
});

describe('every layout survives a Cloud page', () => {
    const layouts = [
        ['DETAILED', renderDetailedLayout],
        ['COMPACT', renderCompactLayout],
        ['OVERVIEW', renderOverviewLayout],
        ['TREE', renderTreeLayout],
        ['MINIMAL', renderMinimalLayout],
    ];

    test.each(layouts)('%s renders the recorded page without throwing', (_name, renderer) => {
        const snapshot = toSnapshot(load('emeraldhost.full.json'), EMERALD);
        expect(() => renderer(snapshot, 'de')).not.toThrow();
        expect(() => renderer(snapshot, 'en')).not.toThrow();
    });

    test.each(layouts)('%s handles an empty Cloud page', (_name, renderer) => {
        const snapshot = snapshotOf([]);
        expect(() => renderer(snapshot, 'de')).not.toThrow();
    });
});
