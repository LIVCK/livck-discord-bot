#!/usr/bin/env node
/**
 * Generate the frozen payload corpus.
 *
 * Run deliberately, never from a test:
 *
 *   node scripts/generate-corpus.js
 *
 * WHY FROZEN. A generator called at test time makes every run a different test — a failure
 * that cannot be reproduced and a pass that proves nothing in particular. These are written to
 * disk once and committed, so the suite always runs against the same bytes, a diff shows
 * exactly which payload changed, and a reviewer can open one and read it.
 *
 * WHY GENERATED AT ALL. Hand-written fixtures end up describing what the author already had in
 * mind: names of a comfortable length, one incident, two groups. Real payloads have a
 * component called "TeamSpeak 3 — Frankfurt (Legacy)", an incident body with three paragraphs
 * and a list, and a page with nineteen services in six groups. faker with a fixed seed gives
 * that variety without anyone inventing it.
 *
 * The scenarios below are deliberate; only their content is generated. Each one is a situation
 * the bot has to handle correctly, and together they are what a fleet of customer pages
 * actually looks like.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fakerDE as faker } from '@faker-js/faker';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '../__tests__/fixtures/corpus');

const SEED = 20260912;

/** A LIVCK-shaped public id: 21 characters, URL-safe. */
const publicId = () => faker.string.alphanumeric({ length: 21, casing: 'mixed' });

const SERVICE_KINDS = [
    ['Gameserver', 'Game servers'], ['Webhosting', 'Web hosting'], ['TeamSpeak', 'TeamSpeak'],
    ['Rootserver', 'Root servers'], ['Datenbank', 'Database'], ['Mailserver', 'Mail'],
    ['Kundenportal', 'Customer portal'], ['API', 'API'], ['DNS', 'DNS'], ['Backup', 'Backup'],
    ['Objektspeicher', 'Object storage'], ['Loadbalancer', 'Load balancer'],
];

const REGIONS = ['Frankfurt', 'Nürnberg', 'Helsinki', 'Falkenstein', 'Amsterdam', 'Wien'];

const bilingual = (de, en) => ({ de, en });

const serviceName = () => {
    const [de, en] = faker.helpers.arrayElement(SERVICE_KINDS);
    const region = faker.helpers.arrayElement(REGIONS);
    const suffix = faker.helpers.arrayElement(['', '', '', ` (${faker.helpers.arrayElement(['Legacy', 'Beta', 'v2'])})`]);
    return bilingual(`${de} ${region}${suffix}`, `${en} ${region}${suffix}`);
};

const groupName = () => {
    const [de, en] = faker.helpers.arrayElement(SERVICE_KINDS);
    return bilingual(de, en);
};

const component = ({ status = 'operational', name = serviceName() } = {}) => ({
    id: publicId(), name, description: null, status,
    is_visible: true, is_group: false, show_uptime_bars: false,
    hide_operational_children: false, default_open: true,
});

const group = ({ children = [], status = 'operational', hides = false, name = groupName() } = {}) => ({
    id: publicId(), name, description: null, status,
    is_visible: true, is_group: true, show_uptime_bars: false,
    hide_operational_children: hides, default_open: true,
    children,
    ...(hides ? { children_total: children.length + faker.number.int({ min: 4, max: 80 }), children_hidden: faker.number.int({ min: 4, max: 80 }) } : {}),
});

/** An incident body that reads like one a human wrote. */
const incidentBody = () => {
    const affected = faker.helpers.arrayElements(SERVICE_KINDS, { min: 1, max: 3 }).map(([de]) => de);
    return bilingual(
        `Wir haben eine Störung an **${affected[0]}** festgestellt.\n\n` +
        `Betroffen sind:\n${affected.map((a) => `- ${a}`).join('\n')}\n\n` +
        `${faker.lorem.sentences(2)}\n\nWir halten euch hier auf dem Laufenden.`,
        `We are seeing a problem with **${affected[0]}**.\n\n` +
        `Affected:\n${affected.map((a) => `- ${a}`).join('\n')}\n\n` +
        `${faker.lorem.sentences(2)}\n\nWe will keep you posted here.`,
    );
};

const incident = ({ status = 'investigating', severity = 'major', updates = 1 } = {}) => {
    const states = ['investigating', 'identified', 'monitoring', 'resolved'];
    const start = faker.date.recent({ days: 1 });

    return {
        id: publicId(),
        title: bilingual(`Störung: ${faker.helpers.arrayElement(SERVICE_KINDS)[0]}`,
                         `Outage: ${faker.helpers.arrayElement(SERVICE_KINDS)[1]}`),
        severity,
        status,
        started_at: start.toISOString(),
        resolved_at: status === 'resolved' ? new Date(start.getTime() + 3.6e6).toISOString() : null,
        updates: Array.from({ length: updates }, (_, i) => ({
            id: publicId(),
            status: states[Math.min(i, states.length - 1)],
            message: bilingual(faker.lorem.sentences(2), faker.lorem.sentences(2)),
            created_at: new Date(start.getTime() + (i + 1) * 12e5).toISOString(),
        })),
        affected_components: [], affected_services: [], attachments: [], postmortem: null,
    };
};

const maintenance = ({ status = 'scheduled', updates = 0 } = {}) => {
    const start = faker.date.soon({ days: 3 });
    return {
        id: publicId(),
        title: bilingual(`Wartung: ${faker.helpers.arrayElement(SERVICE_KINDS)[0]}`,
                         `Maintenance: ${faker.helpers.arrayElement(SERVICE_KINDS)[1]}`),
        status,
        scheduled_start: start.toISOString(),
        scheduled_end: new Date(start.getTime() + 7.2e6).toISOString(),
        started_at: status === 'scheduled' ? null : start.toISOString(),
        completed_at: status === 'completed' ? new Date(start.getTime() + 7.2e6).toISOString() : null,
        updates: Array.from({ length: updates }, (_, i) => ({
            id: publicId(),
            status: ['in_progress', 'completed'][Math.min(i, 1)],
            message: bilingual(faker.lorem.sentence(), faker.lorem.sentence()),
            created_at: new Date(start.getTime() + i * 36e5).toISOString(),
        })),
        affected_components: [], affected_services: [],
    };
};

const notice = () => ({
    id: publicId(),
    title: bilingual('Hinweis zu Phishing-Mails', 'Notice about phishing mails'),
    started_at: faker.date.recent({ days: 2 }).toISOString(),
    updates: [], affected_components: [],
});

const cloudPage = ({ components, incidents = [], notices = [], active = [], scheduled = [] }) => ({
    meta: {
        id: publicId(),
        name: bilingual(`${faker.company.name()} Status`, `${faker.company.name()} Status`),
        slug: faker.helpers.slugify(faker.company.name()).toLowerCase(),
        supported_locales: ['de', 'en'],
        default_locale: 'de',
        show_incident_history: true,
        access_type: 'public',
    },
    components,
    active_incidents: incidents,
    notices,
    maintenances: { active, scheduled },
    metrics: [],
});

const spread = (n, statuses) => Array.from({ length: n }, () =>
    component({ status: faker.helpers.arrayElement(statuses) }));

/** Each entry is a situation the bot has to get right. Only the content is generated. */
const SCENARIOS = {
    'cloud-01-all-green': () => cloudPage({
        components: Array.from({ length: 5 }, () => group({ children: spread(4, ['operational']) })),
    }),
    'cloud-02-single-outage': () => cloudPage({
        components: [
            group({ children: [...spread(3, ['operational']), component({ status: 'major_outage' })], status: 'major_outage' }),
            group({ children: spread(4, ['operational']) }),
        ],
        incidents: [incident({ status: 'identified', updates: 2 })],
    }),
    // `degraded`, not `degraded_performance`. The latter is Atlassian's spelling; LIVCK's
    // enum has never had it, so the adapter mapped every one of these to `unknown` and this
    // scenario tested the opposite of its own name.
    'cloud-03-degraded-only': () => cloudPage({
        components: [group({ children: spread(6, ['degraded', 'operational']), status: 'degraded' })],
    }),
    'cloud-04-maintenance-window': () => cloudPage({
        components: [group({ children: spread(3, ['under_maintenance', 'operational']), status: 'under_maintenance' })],
        active: [maintenance({ status: 'in_progress', updates: 1 })],
    }),
    'cloud-05-hiding-group': () => cloudPage({
        components: [
            group({ children: [], hides: true }),
            group({ children: spread(3, ['operational']) }),
        ],
    }),
    'cloud-06-hiding-group-with-outage': () => cloudPage({
        components: [group({ children: [component({ status: 'major_outage' })], hides: true, status: 'major_outage' })],
        incidents: [incident({ status: 'investigating', severity: 'critical' })],
    }),
    'cloud-07-nested-two-deep': () => cloudPage({
        components: [group({ children: [group({ children: spread(3, ['operational', 'partial_outage']) })] })],
    }),
    'cloud-08-large-fleet': () => cloudPage({
        components: Array.from({ length: 8 }, () =>
            group({ children: spread(9, ['operational', 'operational', 'operational', 'partial_outage']) })),
    }),
    'cloud-09-ungrouped-services': () => cloudPage({ components: spread(6, ['operational', 'major_outage']) }),
    'cloud-10-everything-at-once': () => cloudPage({
        components: [group({ children: spread(5, ['operational', 'major_outage', 'under_maintenance']), status: 'major_outage' })],
        incidents: [incident({ status: 'monitoring', updates: 3 })],
        notices: [notice()],
        active: [maintenance({ status: 'in_progress' })],
        scheduled: [maintenance({ status: 'scheduled' })],
    }),
    'cloud-11-notice-only': () => cloudPage({
        components: [group({ children: spread(3, ['operational']) })],
        notices: [notice()],
    }),
    'cloud-12-empty-page': () => cloudPage({ components: [] }),
    'cloud-13-resolved-incident': () => cloudPage({
        components: [group({ children: spread(4, ['operational']) })],
        incidents: [incident({ status: 'resolved', updates: 3 })],
    }),
    'cloud-14-many-small-groups': () => cloudPage({
        components: Array.from({ length: 14 }, () => group({ children: spread(2, ['operational']) })),
    }),
    // A healthy page WITH an active maintenance window. The rollup rescues it to the
    // page-level `maintenance` status, which is a different value from a component's
    // `under_maintenance` and was produced by nothing in the corpus.
    'cloud-16-maintenance-rescue': () => cloudPage({
        components: [group({ children: spread(4, ['operational']) })],
        active: [maintenance({ status: 'in_progress', updates: 1 })],
    }),
    // Every status the Cloud can send, side by side, so one scenario alone proves the
    // vocabulary is complete.
    'cloud-17-every-status': () => cloudPage({
        components: [group({
            status: 'major_outage',
            children: ['operational', 'degraded', 'partial_outage', 'major_outage', 'under_maintenance', 'unknown']
                .map((status) => component({ status })),
        })],
    }),
    'cloud-15-partial-across-groups': () => cloudPage({
        components: Array.from({ length: 4 }, (_, i) =>
            group({ children: spread(4, i === 0 ? ['partial_outage'] : ['operational']),
                    status: i === 0 ? 'partial_outage' : 'operational' })),
    }),
};

/** Self-hosted answers `/api/v3/categories` with an object keyed by uuid. */
const selfHostedPage = (categories) => Object.fromEntries(categories.map((c) => [c.id, c]));

const shCategory = (monitors) => ({
    id: faker.string.uuid(),
    name: groupName().de,
    monitors,
});

const shMonitors = (n, states) => Array.from({ length: n }, () => ({
    id: faker.string.uuid(),
    name: serviceName().de,
    state: faker.helpers.arrayElement(states),
}));

const SELF_HOSTED = {
    'selfhosted-01-all-available': () => selfHostedPage([
        shCategory(shMonitors(5, ['AVAILABLE'])),
        shCategory(shMonitors(3, ['AVAILABLE'])),
    ]),
    'selfhosted-02-one-down': () => selfHostedPage([
        shCategory([...shMonitors(3, ['AVAILABLE']), { id: faker.string.uuid(), name: serviceName().de, state: 'UNAVAILABLE' }]),
    ]),
    'selfhosted-03-maintenance': () => selfHostedPage([shCategory(shMonitors(4, ['MAINTENANCE', 'AVAILABLE']))]),
    // DEGRADED is mapped by the adapter and was in no payload; PENDING is not mapped, and
    // must land on `unknown` rather than be assumed healthy.
    'selfhosted-07-every-state': () => selfHostedPage([
        shCategory(['AVAILABLE', 'UNAVAILABLE', 'DEGRADED', 'MAINTENANCE', 'PENDING'].map((state) => ({
            id: faker.string.uuid(), name: serviceName().de, state,
        }))),
    ]),
    'selfhosted-04-empty-category': () => selfHostedPage([shCategory([]), shCategory(shMonitors(2, ['AVAILABLE']))]),
    'selfhosted-05-large': () => selfHostedPage(Array.from({ length: 8 }, () => shCategory(shMonitors(7, ['AVAILABLE', 'AVAILABLE', 'UNAVAILABLE'])))),
    'selfhosted-06-no-categories': () => selfHostedPage([]),
};

fs.mkdirSync(OUT, { recursive: true });
for (const file of fs.readdirSync(OUT)) fs.unlinkSync(path.join(OUT, file));

faker.seed(SEED);
faker.setDefaultRefDate('2026-09-12T12:00:00.000Z'); // frozen, so dates never drift

let written = 0;
for (const [name, build] of Object.entries({ ...SCENARIOS, ...SELF_HOSTED })) {
    const payload = build();
    fs.writeFileSync(path.join(OUT, `${name}.json`), `${JSON.stringify(payload, null, 2)}\n`);
    written += 1;
}

console.log(`Wrote ${written} payloads to ${path.relative(process.cwd(), OUT)} (seed ${SEED}).`);
