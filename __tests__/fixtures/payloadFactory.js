/**
 * Build LIVCK payloads to order, in the exact shape the two APIs return.
 *
 * The live pages only ever show what they happen to be doing today. This builds the rest: a
 * group nested four deep, a component whose name exists in a language nobody asked for, an
 * incident in every state it can reach, two hundred services, none at all. Field names and
 * nesting are taken from the recorded fixtures (`cloud.full.json`, `emeraldhost.full.json`,
 * `selfhosted.categories.json`), so a payload from here goes through the real adapters
 * unchanged.
 *
 * Everything is deterministic — no clock, no randomness that is not seeded — because a test
 * that fails once a week teaches nobody anything.
 */

import { KNOWN_STATUSES as ADAPTER_STATUSES } from '../../providers/cloud.js';

/**
 * Cloud component statuses, taken FROM THE ADAPTER rather than retyped.
 *
 * The hand-typed version said `degraded_performance` — Atlassian's spelling, not a value in
 * LIVCK's enum. The adapter rejected it, so every payload built from that list carried
 * `unknown` where it meant `degraded`, and the one status a busy page shows most often had
 * never been rendered by any test. Deriving it means the list cannot drift from what the
 * adapter accepts; `statusVocabularyIsComplete` in the matrix fails if it ever tries.
 */
export const CLOUD_STATUSES = [...ADAPTER_STATUSES];

/**
 * Self-hosted monitor states the adapter maps, plus one it deliberately does not.
 *
 * `DEGRADED` was missing, which is the same omission from the other direction. `PENDING` is
 * kept on purpose: it is not in the map, and a state the adapter does not recognise must land
 * on `unknown` rather than be assumed healthy.
 */
export const SELF_HOSTED_STATES = ['AVAILABLE', 'UNAVAILABLE', 'DEGRADED', 'MAINTENANCE', 'PENDING'];

export const INCIDENT_STATES = ['investigating', 'identified', 'monitoring', 'resolved'];
export const INCIDENT_SEVERITIES = ['minor', 'major', 'critical'];
export const MAINTENANCE_STATES = ['scheduled', 'in_progress', 'completed'];

/** Name shapes that a real status page produces, including the awkward ones. */
export const NAME_SHAPES = {
    plain: { de: 'Datenbank', en: 'Database' },
    onlyDefault: { de: 'Nur Deutsch' },
    foreignOnly: { zh: '数据库' },
    clearedTranslation: { de: null, en: 'Database' },
    emptyTranslation: { de: '', en: 'Database' },
    emptyMap: {},
    long: { de: 'D'.repeat(300), en: 'D'.repeat(300) },
    emoji: { de: '🟢 Datenbank ✨', en: '🟢 Database ✨' },
    cjk: { de: '데이터베이스 데이터베이스', en: '데이터베이스' },
    markdownish: { de: '**Datenbank** `prod` _eu_', en: '**Database**' },
    mentionish: { de: '@everyone Datenbank', en: '@here Database' },
    linkish: { de: '[Datenbank](https://evil.example)', en: 'Database' },
};

let counter = 0;
const nextId = (prefix) => `${prefix}-${(counter += 1)}`;

/** Reset the id counter so two runs of the same spec produce identical payloads. */
export const resetIds = () => { counter = 0; };

/**
 * One Cloud component (a leaf) or group.
 *
 * @param {object} spec
 * @param {boolean} [spec.group]
 * @param {string} [spec.status]
 * @param {object|string} [spec.name]
 * @param {Array} [spec.children]
 * @param {boolean} [spec.hidesChildren] - the group prunes its healthy children server-side
 * @param {number} [spec.childrenTotal]
 * @param {boolean} [spec.visible]
 */
export const cloudComponent = ({
    group = false,
    status = 'operational',
    name = NAME_SHAPES.plain,
    children = [],
    hidesChildren = false,
    childrenTotal = null,
    childrenHidden = null,
    visible = true,
    description = null,
} = {}) => {
    const node = {
        id: nextId(group ? 'g' : 'c'),
        name,
        description,
        status,
        is_visible: visible,
        is_group: group,
        show_uptime_bars: false,
        hide_operational_children: hidesChildren,
        default_open: true,
    };

    if (group) {
        node.children = children;
        if (childrenTotal !== null) node.children_total = childrenTotal;
        if (childrenHidden !== null) node.children_hidden = childrenHidden;
    }

    return node;
};

/** A chain of groups `depth` levels deep, with the leaves at the bottom. */
export const nestedGroups = (depth, leaves, { hidesAt = null, status = 'operational' } = {}) => {
    let node = leaves.length > 0
        ? leaves
        : [];

    for (let level = depth; level >= 1; level -= 1) {
        const hides = hidesAt === level;
        node = [cloudComponent({
            group: true,
            status,
            name: { de: `Ebene ${level}`, en: `Level ${level}` },
            children: hides ? [] : node,
            hidesChildren: hides,
            childrenTotal: hides ? 66 : null,
            childrenHidden: hides ? 66 : null,
        })];
    }

    return node;
};

export const cloudIncident = ({
    state = 'investigating',
    severity = 'major',
    updates = 1,
    title = { de: 'Störung', en: 'Outage' },
    startedAt = '2026-09-10T10:00:00+00:00',
} = {}) => ({
    id: nextId('inc'),
    title,
    severity,
    status: state,
    started_at: startedAt,
    resolved_at: state === 'resolved' ? '2026-09-10T12:00:00+00:00' : null,
    updates: Array.from({ length: updates }, (_, i) => ({
        id: nextId('u'),
        status: INCIDENT_STATES[Math.min(i, INCIDENT_STATES.length - 1)],
        message: { de: `Update ${i + 1}`, en: `Update ${i + 1}` },
        created_at: `2026-09-10T1${i}:00:00+00:00`,
    })),
    affected_components: [],
    affected_services: [],
    attachments: [],
    postmortem: null,
});

export const cloudMaintenance = ({
    state = 'scheduled',
    updates = 0,
    title = { de: 'Wartung', en: 'Maintenance' },
} = {}) => ({
    id: nextId('mnt'),
    title,
    status: state,
    scheduled_start: '2026-09-12T08:00:00+00:00',
    scheduled_end: '2026-09-12T10:00:00+00:00',
    started_at: state === 'scheduled' ? null : '2026-09-12T08:00:00+00:00',
    completed_at: state === 'completed' ? '2026-09-12T10:00:00+00:00' : null,
    updates: Array.from({ length: updates }, (_, i) => ({
        id: nextId('mu'),
        status: MAINTENANCE_STATES[Math.min(i, MAINTENANCE_STATES.length - 1)],
        message: { de: `Wartungs-Update ${i + 1}`, en: `Maintenance update ${i + 1}` },
        created_at: `2026-09-12T0${8 + i}:30:00+00:00`,
    })),
    affected_components: [],
    affected_services: [],
});

export const cloudNotice = ({ title = { de: 'Hinweis', en: 'Notice' }, updates = 0 } = {}) => ({
    id: nextId('note'),
    title,
    started_at: '2026-09-09T08:00:00+00:00',
    updates: Array.from({ length: updates }, (_, i) => ({
        id: nextId('nu'),
        message: { de: `Hinweis-Update ${i + 1}`, en: `Notice update ${i + 1}` },
        created_at: `2026-09-09T0${9 + i}:00:00+00:00`,
    })),
    affected_components: [],
});

/** A complete `/api/statuspage/{id}/full` payload. */
export const cloudFull = ({
    components = [],
    incidents = [],
    notices = [],
    activeMaintenances = [],
    scheduledMaintenances = [],
    name = { de: 'Beispielseite', en: 'Example page' },
    defaultLocale = 'de',
    locales = ['de', 'en'],
    indicator = null,
} = {}) => ({
    meta: {
        id: 'page-id',
        name,
        slug: 'example',
        supported_locales: locales,
        default_locale: defaultLocale,
        show_incident_history: true,
        access_type: 'public',
    },
    components,
    active_incidents: incidents,
    notices,
    maintenances: { active: activeMaintenances, scheduled: scheduledMaintenances },
    metrics: [],
    ...(indicator ? { status: { indicator } } : {}),
});

/** Self-hosted `/api/v3/categories`: an object keyed by uuid, not an array. */
export const selfHostedCategories = (categories) => Object.fromEntries(
    categories.map((category) => [category.id, category])
);

export const selfHostedCategory = ({ name = 'Plattform', monitors = [] } = {}) => ({
    id: nextId('cat'),
    name,
    monitors,
});

export const selfHostedMonitor = ({ name = 'API', state = 'AVAILABLE' } = {}) => ({
    id: nextId('mon'),
    name,
    state,
});

export default {
    CLOUD_STATUSES, SELF_HOSTED_STATES, INCIDENT_STATES, INCIDENT_SEVERITIES, MAINTENANCE_STATES,
    NAME_SHAPES, cloudComponent, nestedGroups, cloudIncident, cloudMaintenance, cloudNotice,
    cloudFull, selfHostedCategories, selfHostedCategory, selfHostedMonitor, resetIds,
};
