/**
 * The bot's internal status-page model.
 *
 * Two backends feed it — a self-hosted LIVCK instance (`/api/v3`, `/api/v1`) and the LIVCK
 * Cloud — and everything downstream (four layouts, two handlers) reads only this. Without it
 * every renderer would need an `if (cloud)`.
 *
 * WHY THE CLOUD VOCABULARY IS THE CANON
 *
 * Normalizing the other way round is cheaper — flatten the Cloud tree into
 * `categories[].monitors[]` and no renderer changes at all — but it destroys information
 * permanently: `partial_outage` and `major_outage` collapse into one `UNAVAILABLE`, and an
 * advisory becomes indistinguishable from an outage. The Cloud set is a strict superset, so
 * self-hosted maps UP into it and nothing is lost in either direction.
 *
 * Nothing changes on the Edge or in Laravel for this. It is a bot-side model only.
 *
 * TRANSLATABLE FIELDS STAY UNRESOLVED
 *
 * `name`, `description`, `title` and `body` hold either a plain string (self-hosted, which
 * renders server-side per `Accept-Language`) or a locale map like `{de: '…', en: '…'}` (Cloud,
 * which ships every language at once). Resolution happens in the renderer, so ONE fetch can
 * serve subscriptions in different languages — see resolveText().
 */

export const DTO_VERSION = 1;

/**
 * Component status. Mirrors the Cloud's ComponentStatus plus the page-level `maintenance`
 * token, which only ever appears as an overall status.
 */
export const STATUS = {
    OPERATIONAL: 'operational',
    DEGRADED: 'degraded',
    PARTIAL_OUTAGE: 'partial_outage',
    MAJOR_OUTAGE: 'major_outage',
    UNDER_MAINTENANCE: 'under_maintenance',
    UNKNOWN: 'unknown',
    /** Overall only: an otherwise healthy page inside an active maintenance window. */
    MAINTENANCE: 'maintenance',
};

/** Where a snapshot came from. */
export const SOURCE = {
    SELF_HOSTED: 'SELF_HOSTED',
    CLOUD: 'CLOUD',
};

/** What kind of message an alert is. A notice makes no claim about service state. */
export const ALERT_KIND = {
    INCIDENT: 'incident',
    MAINTENANCE: 'maintenance',
    NOTICE: 'notice',
};

/** Body markup, so the renderer knows which converter to use. */
export const BODY_FORMAT = {
    HTML: 'html',       // self-hosted
    MARKDOWN: 'markdown', // cloud
};

/**
 * Resolve a Translatable to one string.
 *
 * Chain: requested locale → page default → the first usable value → fallback. Mirrors the
 * Cloud's own `resolveTranslatable`, because a page may offer languages the subscription does
 * not use, and a locale key may be present but null (a cleared translation is persisted as
 * null, not removed).
 *
 * @param {string|Object|null|undefined} value
 * @param {string} locale
 * @param {string} [defaultLocale]
 * @param {string} [fallback]
 */
export const resolveText = (value, locale, defaultLocale = 'en', fallback = '') => {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'string') return value;
    if (typeof value !== 'object') return fallback;

    const usable = (key) => typeof value[key] === 'string' && value[key] !== '';

    if (usable(locale)) return value[locale];
    if (usable(defaultLocale)) return value[defaultLocale];

    // Deterministic rather than object-key order, so the same payload always renders alike.
    const remaining = Object.keys(value).sort().find(usable);
    return remaining ? value[remaining] : fallback;
};

/**
 * One service (a leaf component / monitor).
 *
 * @param {object} input
 * @param {string} input.id
 * @param {string|Object} input.name
 * @param {string|Object|null} [input.description]
 * @param {string} input.status - one of STATUS
 * @param {number|null} [input.uptime] - percentage 0-100, when the source provides one
 */
export const makeService = ({ id, name, description = null, status, uptime = null }) => Object.freeze({
    id,
    name,
    description,
    status,
    uptime,
});

/**
 * A group of services.
 *
 * Nesting is flattened here rather than kept as a tree: Discord offers exactly two structural
 * levels (a field and its value), so depth has to become typography. `depth` and `path` carry
 * what the renderer needs to show it — `path` is the chain of ancestor names, used for a
 * breadcrumb once indentation stops being readable.
 *
 * @param {object} input
 * @param {number} [input.depth] - 0 for a top-level group
 * @param {string[]} [input.path] - ancestor names, outermost first
 * @param {number|null} [input.childrenTotal] - Cloud groups that hide healthy children
 * @param {number|null} [input.childrenHidden]
 */
export const makeGroup = ({
    id,
    name,
    description = null,
    status,
    depth = 0,
    path = [],
    services = [],
    childrenTotal = null,
    childrenHidden = null,
}) => Object.freeze({
    id,
    name,
    description,
    status,
    depth,
    path: Object.freeze([...path]),
    services: Object.freeze(services),
    childrenTotal,
    childrenHidden,
});

/**
 * One update inside an alert's timeline.
 *
 * @param {object} input
 * @param {string} input.id - stable across cycles; becomes Message.serviceId
 * @param {string|null} [input.state]
 * @param {string|Object} input.body
 * @param {string} input.createdAt - ISO 8601
 */
export const makeUpdate = ({ id, state = null, body, createdAt }) => Object.freeze({
    id,
    state,
    body,
    createdAt,
});

/**
 * An announcement: an incident, a maintenance window, or a standing advisory.
 *
 * The three are ONE list because they take the same route through Discord — a parent message
 * with its updates threaded underneath — but `kind` must survive, because a notice may never
 * be coloured like an outage or ping an on-call role.
 *
 * @param {object} input
 * @param {string} input.kind - one of ALERT_KIND
 * @param {string} input.url - link to the alert on the status page
 * @param {string|null} [input.severity] - minor|major|critical; null for a notice
 * @param {string|null} [input.state] - lifecycle state; null for a notice
 * @param {{start: string, end: string|null}|null} [input.window] - maintenance only
 * @param {Array} [input.components] - affected components, `[{id, name, status}]`
 */
export const makeAlert = ({
    id,
    kind,
    url,
    title,
    body = null,
    format,
    severity = null,
    state = null,
    startedAt,
    endedAt = null,
    window = null,
    components = [],
    updates = [],
}) => Object.freeze({
    id,
    kind,
    url,
    title,
    body,
    format,
    severity,
    state,
    startedAt,
    endedAt,
    window: window ? Object.freeze({ ...window }) : null,
    components: Object.freeze(components),
    updates: Object.freeze(updates),
});

/**
 * A complete view of one status page at one moment.
 *
 * @param {object} input
 * @param {string} input.source - one of SOURCE
 * @param {string} input.url
 * @param {string|Object} input.name
 * @param {string} input.overall - one of STATUS
 * @param {string} [input.defaultLocale] - anchor for resolveText
 * @param {string[]} [input.locales] - languages this page offers
 */
export const makeSnapshot = ({
    source,
    url,
    name,
    overall,
    defaultLocale = 'en',
    locales = [],
    groups = [],
    alerts = [],
}) => Object.freeze({
    v: DTO_VERSION,
    source,
    url,
    name,
    overall,
    defaultLocale,
    locales: Object.freeze([...locales]),
    groups: Object.freeze(groups),
    alerts: Object.freeze(alerts),
});

/** Every service across every group, in display order. */
export const allServices = (snapshot) => snapshot.groups.flatMap((group) => group.services);

export default { makeSnapshot, makeGroup, makeService, makeAlert, makeUpdate, resolveText, STATUS, SOURCE, ALERT_KIND, BODY_FORMAT, DTO_VERSION };
