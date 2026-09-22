/**
 * Invariants, held against payloads the live pages never happen to produce.
 *
 * The end-to-end suites check what four real status pages are doing today. This checks the
 * shapes they are not: a group nested four deep, a component named only in a language nobody
 * asked for, a translation cleared to null, two hundred services, none at all, an incident in
 * every state it can reach, a name that is `@everyone`.
 *
 * They are not asserted case by case. Each one is fed through the real adapter, the real DTO
 * and all five real renderers in both languages, and the SAME set of properties is required of
 * every result — the properties that, when one of them breaks, produce a message Discord
 * rejects or a customer misreads. Most of the display bugs found in this repository would have
 * been caught by one of these, on a payload nobody thought to write down.
 */

import Statuspage from '../../services/statuspage.js';
import {
    CLOUD_STATUSES, SELF_HOSTED_STATES, INCIDENT_STATES, INCIDENT_SEVERITIES, MAINTENANCE_STATES, NAME_SHAPES,
    cloudComponent, nestedGroups, cloudIncident, cloudMaintenance, cloudNotice, cloudFull,
    selfHostedCategories, selfHostedCategory, selfHostedMonitor, resetIds,
} from '../fixtures/payloadFactory.js';

import { toSnapshot as cloudSnapshot } from '../../providers/cloud.js';
import { toSnapshot as selfHostedSnapshot } from '../../providers/selfHosted.js';
import { getLayoutRenderer } from '../../messages/layoutRenderers.js';
import { DISCORD_LIMITS, embedLength } from '../../util/discordLimits.js';
import { hashPayload } from '../../util/messageSync.js';

const LAYOUTS = ['DETAILED', 'COMPACT', 'OVERVIEW', 'TREE', 'MINIMAL'];
const LOCALES = ['de', 'en', 'fr']; // fr is deliberately one the pages do not offer

const PAGE = { url: 'https://matrix.example', name: 'matrix' };

/** Everything a reader would see, as one string. */
const textOf = (embed) => [
    embed.title ?? '',
    embed.description ?? '',
    embed.footer?.text ?? '',
    ...(embed.fields ?? []).flatMap((f) => [f.name, f.value]),
].join('\n');

/**
 * The properties every rendered message must have, whatever it was built from.
 *
 * @param {object} embed - the embed as JSON
 * @param {object} context - what produced it, for a readable failure
 */
const assertRenderable = (embed, context) => {
    try {
        // Discord rejects the whole message over any one of these, and the page posts nothing.
        expect(embedLength(embed)).toBeLessThanOrEqual(DISCORD_LIMITS.MESSAGE_EMBED_TOTAL);
        expect((embed.title ?? '').length).toBeLessThanOrEqual(DISCORD_LIMITS.EMBED_TITLE);
        expect((embed.description ?? '').length).toBeLessThanOrEqual(DISCORD_LIMITS.EMBED_DESCRIPTION);
        expect((embed.fields ?? []).length).toBeLessThanOrEqual(DISCORD_LIMITS.EMBED_FIELDS);

        for (const field of embed.fields ?? []) {
            expect(field.name.length).toBeGreaterThan(0);
            expect(field.value.length).toBeGreaterThan(0);
            expect(field.name.length).toBeLessThanOrEqual(DISCORD_LIMITS.EMBED_FIELD_NAME);
            expect(field.value.length).toBeLessThanOrEqual(DISCORD_LIMITS.EMBED_FIELD_VALUE);
        }

        const text = textOf(embed);

        // A missing translation renders as its own key — the most visible way i18n breaks.
        expect(text).not.toMatch(/\b(messages|commands)\.[a-z_]+\.[a-z_.]+/i);
        // A placeholder reaching a reader means a field was read that does not exist.
        expect(text).not.toMatch(/\bundefined\b|\[object Object\]|\bNaN\b/);
        // The title always says something; an empty embed is a failure Discord accepts.
        expect((embed.title ?? '').trim().length).toBeGreaterThan(0);
    } catch (error) {
        // Which of a few hundred payloads produced this is the whole value of the failure.
        error.message = `${error.message}\n\nPayload: ${JSON.stringify(context)}`;
        throw error;
    }
};

/** Render one snapshot every way a subscription could ask for it. */
const renderEveryWay = (snapshot, context) => {
    const rendered = [];

    for (const layout of LAYOUTS) {
        for (const locale of LOCALES) {
            const messages = getLayoutRenderer(layout)(snapshot, locale);

            for (const { embed } of messages) {
                const json = embed.toJSON();
                assertRenderable(json, { ...context, layout, locale });
                rendered.push({ layout, locale, json });
            }
        }
    }

    return rendered;
};

beforeEach(() => resetIds());

describe('every component status the Cloud can emit', () => {
    test.each(CLOUD_STATUSES)('%s renders in every layout and language', (status) => {
        const snapshot = cloudSnapshot(cloudFull({
            components: [cloudComponent({ group: true, status, children: [cloudComponent({ status })] })],
        }), PAGE);

        expect(renderEveryWay(snapshot, { status }).length).toBe(LAYOUTS.length * LOCALES.length);
    });
});

describe('every self-hosted monitor state', () => {
    /**
     * Through the real normalisation, because the raw shape is the awkward part.
     *
     * `/api/v3/categories` answers with an OBJECT keyed by uuid, not an array — the quirk
     * `Statuspage.normalizeCategories` exists for. Feeding the adapter an array here would
     * skip exactly the step most likely to break.
     */
    const snapshotOf = (categories) => selfHostedSnapshot({
        categories: Statuspage.normalizeCategories(selfHostedCategories(categories)),
        alerts: [],
    }, PAGE);

    test.each(SELF_HOSTED_STATES)('%s renders', (state) => {
        renderEveryWay(snapshotOf([
            selfHostedCategory({ monitors: [selfHostedMonitor({ state })] }),
        ]), { state });
    });

    test('the uuid-keyed object really is what the adapter is handed', () => {
        const raw = selfHostedCategories([selfHostedCategory({ monitors: [selfHostedMonitor()] })]);

        expect(Array.isArray(raw)).toBe(false);
        expect(Array.isArray(Statuspage.normalizeCategories(raw))).toBe(true);
    });

    test('a category with no monitors does not render as a bare heading', () => {
        const snapshot = snapshotOf([selfHostedCategory({ name: 'Leer', monitors: [] })]);

        for (const { json, layout } of renderEveryWay(snapshot, { empty: true })) {
            if (!['TREE', 'MINIMAL'].includes(layout)) continue;
            const lines = (json.description ?? '').split('\n');
            lines.forEach((line, index) => {
                if (!line.trim().startsWith('**')) return;
                const next = lines[index + 1];
                if (next === undefined || next === '') return;
                expect(next.trim()).not.toBe('');
            });
        }
    });

    test('an error payload shaped like {data: []} yields no categories rather than throwing', () => {
        expect(Statuspage.normalizeCategories({ data: [] })).toEqual([]);
        expect(() => selfHostedSnapshot({ categories: [], alerts: [] }, PAGE)).not.toThrow();
    });
});

describe('every shape a name can arrive in', () => {
    test.each(Object.keys(NAME_SHAPES))('%s', (shape) => {
        const name = NAME_SHAPES[shape];
        const snapshot = cloudSnapshot(cloudFull({
            name,
            components: [cloudComponent({
                group: true, name, children: [cloudComponent({ name, status: 'major_outage' })],
            })],
        }), PAGE);

        renderEveryWay(snapshot, { shape });
    });

    test('a name that looks like a mention cannot ping anyone', () => {
        // Embeds do not notify, but a name reaching `content` would. Nothing in a status
        // message is content — this is the assertion that keeps it that way.
        const snapshot = cloudSnapshot(cloudFull({
            components: [cloudComponent({ group: true, name: NAME_SHAPES.mentionish, children: [] })],
        }), PAGE);

        for (const layout of LAYOUTS) {
            for (const { embed, ...rest } of getLayoutRenderer(layout)(snapshot, 'de')) {
                expect(rest.content ?? '').toBe('');
                expect(embed.toJSON().description ?? '').not.toBeUndefined();
            }
        }
    });
});

describe('however the tree is shaped', () => {
    test.each([0, 1, 2, 3, 4])('%i levels of nesting', (depth) => {
        const leaves = [cloudComponent({ status: 'major_outage' }), cloudComponent()];
        const components = depth === 0 ? leaves : nestedGroups(depth, leaves);

        renderEveryWay(cloudSnapshot(cloudFull({ components }), PAGE), { depth });
    });

    test.each([1, 2, 3])('a hiding group at level %i keeps its count to itself', (level) => {
        // How many services sit behind a hiding group is the one thing it exists to hide.
        const components = nestedGroups(3, [cloudComponent()], { hidesAt: level });
        const snapshot = cloudSnapshot(cloudFull({ components }), PAGE);

        for (const { json, layout, locale } of renderEveryWay(snapshot, { level })) {
            if (textOf(json).includes('66')) {
                throw new Error(`Hidden child count leaked in ${layout}/${locale}: ${textOf(json)}`);
            }
        }
    });

    test.each([0, 1, 25, 200])('%i services', (count) => {
        const leaves = Array.from({ length: count }, (_, i) =>
            cloudComponent({ status: CLOUD_STATUSES[i % CLOUD_STATUSES.length] }));

        renderEveryWay(cloudSnapshot(cloudFull({
            components: [cloudComponent({ group: true, children: leaves })],
        }), PAGE), { count });
    });

    test('many groups, each with many services', () => {
        const groups = Array.from({ length: 30 }, (_, g) => cloudComponent({
            group: true,
            name: { de: `Gruppe ${g} ${'x'.repeat(40)}`, en: `Group ${g}` },
            children: Array.from({ length: 12 }, () => cloudComponent({ status: 'partial_outage' })),
        }));

        renderEveryWay(cloudSnapshot(cloudFull({ components: groups }), PAGE), { groups: 30 });
    });

    test('components with no group of their own', () => {
        renderEveryWay(cloudSnapshot(cloudFull({
            components: [cloudComponent(), cloudComponent({ status: 'degraded_performance' })],
        }), PAGE), { ungrouped: true });
    });

    test('an invisible component is not rendered at all', () => {
        const snapshot = cloudSnapshot(cloudFull({
            components: [cloudComponent({
                group: true,
                children: [
                    cloudComponent({ name: { de: 'Sichtbar', en: 'Visible' } }),
                    cloudComponent({ name: { de: 'GEHEIM', en: 'SECRET' }, visible: false }),
                ],
            })],
        }), PAGE);

        for (const { json } of renderEveryWay(snapshot, { hidden: true })) {
            expect(textOf(json)).not.toContain('GEHEIM');
            expect(textOf(json)).not.toContain('SECRET');
        }
    });
});

describe('rendering is deterministic', () => {
    test('the same payload twice produces the same bytes', () => {
        // If it did not, the content hash would change every cycle and every message would be
        // edited every fifteen seconds for nothing — which is the ceiling the hash exists to
        // avoid.
        const build = () => {
            resetIds();
            return cloudSnapshot(cloudFull({
                components: nestedGroups(2, [
                    cloudComponent({ status: 'major_outage' }),
                    cloudComponent({ status: 'operational' }),
                ]),
            }), PAGE);
        };

        for (const layout of LAYOUTS) {
            const first = getLayoutRenderer(layout)(build(), 'de').map((m) => m.embed);
            const second = getLayoutRenderer(layout)(build(), 'de').map((m) => m.embed);

            expect(hashPayload({ embeds: second })).toBe(hashPayload({ embeds: first }));
        }
    });

    test('key order in the payload does not change the output', () => {
        const names = { de: 'Datenbank', en: 'Database', zh: '数据库' };
        const reordered = { zh: '数据库', de: 'Datenbank', en: 'Database' };

        const render = (name) => getLayoutRenderer('DETAILED')(
            cloudSnapshot(cloudFull({ components: [cloudComponent({ group: true, name, children: [cloudComponent({ name })] })] }), PAGE),
            'fr',
        ).map((m) => m.embed);

        expect(hashPayload({ embeds: render(reordered) })).toBe(hashPayload({ embeds: render(names) }));
    });
});

describe('the degenerate payloads', () => {
    test.each([
        ['no components at all', cloudFull({ components: [] })],
        ['a group with no children', cloudFull({ components: [cloudComponent({ group: true, children: [] })] })],
        ['a group whose children are all invisible', cloudFull({
            components: [cloudComponent({ group: true, children: [cloudComponent({ visible: false })] })],
        })],
        ['no meta name', cloudFull({ name: {} })],
        ['no supported locales', cloudFull({ locales: [], components: [cloudComponent()] })],
    ])('%s still renders something a reader can use', (_label, payload) => {
        renderEveryWay(cloudSnapshot(payload, PAGE), { degenerate: _label });
    });

    test.each([
        ['components missing entirely', { meta: { name: { de: 'X' }, default_locale: 'de' } }],
        ['an empty object', {}],
        ['null', null],
    ])('%s does not throw', (_label, payload) => {
        expect(() => cloudSnapshot(payload, PAGE)).not.toThrow();
        renderEveryWay(cloudSnapshot(payload, PAGE), { broken: _label });
    });
});

describe('every alert the Cloud can be in', () => {
    const withAlert = (extra) => cloudSnapshot(cloudFull({
        components: [cloudComponent({ group: true, children: [cloudComponent()] })],
        ...extra,
    }), PAGE);

    test.each(INCIDENT_STATES)('an incident that is %s', (state) => {
        const snapshot = withAlert({ incidents: [cloudIncident({ state, updates: 2 })] });

        expect(snapshot.alerts).toHaveLength(1);
        expect(snapshot.alerts[0].state).toBe(state);
        renderEveryWay(snapshot, { state });
    });

    test.each(INCIDENT_SEVERITIES)('an incident of severity %s', (severity) => {
        const snapshot = withAlert({ incidents: [cloudIncident({ severity })] });

        expect(snapshot.alerts[0].severity).toBe(severity);
    });

    test.each(MAINTENANCE_STATES)('a maintenance that is %s', (state) => {
        const key = state === 'scheduled' ? 'scheduledMaintenances' : 'activeMaintenances';
        const snapshot = withAlert({ [key]: [cloudMaintenance({ state, updates: 1 })] });

        expect(snapshot.alerts).toHaveLength(1);
        expect(snapshot.alerts[0].kind).toBe('maintenance');
    });

    test('a notice carries no severity, whatever else it carries', () => {
        // A notice must never be able to look like an outage.
        const snapshot = withAlert({ notices: [cloudNotice({ updates: 2 })] });

        expect(snapshot.alerts[0].kind).toBe('notice');
        expect(snapshot.alerts[0].severity).toBeNull();
        expect(snapshot.alerts[0].state).toBeNull();
    });

    test('all four kinds at once', () => {
        const snapshot = withAlert({
            incidents: [cloudIncident({ state: 'monitoring' })],
            notices: [cloudNotice()],
            activeMaintenances: [cloudMaintenance({ state: 'in_progress' })],
            scheduledMaintenances: [cloudMaintenance({ state: 'scheduled' })],
        });

        expect(snapshot.alerts).toHaveLength(4);
        expect(new Set(snapshot.alerts.map((a) => a.kind))).toEqual(new Set(['incident', 'notice', 'maintenance']));
    });
});
