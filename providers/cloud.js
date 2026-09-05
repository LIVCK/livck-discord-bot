import LIVCKCloud from '../api/livckCloud.js';
import { foldPageStatus } from './cloudRollup.js';
import {
    ALERT_KIND,
    BODY_FORMAT,
    SOURCE,
    STATUS,
    makeAlert,
    makeGroup,
    makeService,
    makeSnapshot,
    makeUpdate,
} from '../dto/statuspage.js';

/**
 * Adapter for a LIVCK Cloud status page.
 *
 * Unlike the self-hosted adapter this derives almost nothing: the Cloud already computed each
 * component's status (including the bottom-up group rollup), so re-deriving it here would only
 * create a way for the bot to disagree with the page a customer is looking at.
 *
 * TREE → TWO LEVELS
 *
 * A Cloud page nests up to five levels deep (`config/livck.php: max_component_depth`). Discord
 * offers exactly two structural levels — a field and its value — so the tree is folded onto
 * TOP-LEVEL groups, and everything below becomes typography inside that group's value:
 * each service carries `path`, the chain of intermediate group names, and the renderer turns
 * that into a sub-heading or a breadcrumb. Making every nested group its own field instead
 * would burn the 25-field budget on headings with nothing under them.
 *
 * Components sitting at the root without a group are collected into one synthetic group, so
 * they are not silently dropped.
 */

/** Status values the Cloud can send. Anything else is treated as unknown rather than assumed up. */
const KNOWN_STATUSES = new Set([
    STATUS.OPERATIONAL,
    STATUS.DEGRADED,
    STATUS.PARTIAL_OUTAGE,
    STATUS.MAJOR_OUTAGE,
    STATUS.UNDER_MAINTENANCE,
    STATUS.UNKNOWN,
]);

export const normalizeStatus = (status) => (KNOWN_STATUSES.has(status) ? status : STATUS.UNKNOWN);

const isVisible = (node) => node?.is_visible !== false;

/**
 * Collect every leaf below a node, recording the group names passed on the way.
 *
 * @param {Array} nodes
 * @param {string[]} path - intermediate group names, relative to the top-level group
 * @param {Array} out
 */
const collectLeaves = (nodes, path, out) => {
    for (const node of nodes || []) {
        if (!isVisible(node)) continue;

        if (node.is_group) {
            collectLeaves(node.children, [...path, node.name], out);
            continue;
        }

        out.push(makeService({
            id: node.id,
            name: node.name,
            description: node.description ?? null,
            status: normalizeStatus(node.status),
            path,
        }));
    }
};

/**
 * Fold the component tree onto top-level groups.
 *
 * @param {Array} components - the tree's root nodes
 */
export const flattenTree = (components = []) => {
    const groups = [];
    const ungrouped = [];

    for (const node of components) {
        if (!isVisible(node)) continue;

        if (!node.is_group) {
            ungrouped.push(makeService({
                id: node.id,
                name: node.name,
                description: node.description ?? null,
                status: normalizeStatus(node.status),
                path: [],
            }));
            continue;
        }

        const services = [];
        collectLeaves(node.children, [], services);

        groups.push(makeGroup({
            id: node.id,
            name: node.name,
            description: node.description ?? null,
            status: normalizeStatus(node.status),
            depth: 0,
            path: [],
            services,
            // Present only on a group that hides its healthy children; the renderer shows
            // "12 of 14 operational" instead of a list that would keep changing length.
            childrenTotal: node.children_total ?? null,
            childrenHidden: node.children_hidden ?? null,
        }));
    }

    if (ungrouped.length > 0) {
        groups.push(makeGroup({
            id: '__ungrouped__',
            name: null,
            labelKey: 'messages.status.ungrouped',
            status: foldPageStatus(ungrouped.map((s) => ({ status: s.status }))),
            depth: 0,
            path: [],
            services: ungrouped,
        }));
    }

    return groups;
};

/**
 * Updates arrive newest-first from the API (Laravel reverses the ASC relation and the Edge
 * renders that order verbatim). The DTO is chronological, and the OLDEST update is the
 * announcement text — a Cloud incident has no body of its own.
 *
 * @returns {{body: string|Object|null, updates: Array}}
 */
export const splitUpdates = (rawUpdates = []) => {
    const chronological = [...rawUpdates].reverse();
    const opening = chronological.shift();

    return {
        // A freshly created incident whose only update is internal arrives with an empty
        // array; the renderer falls back to title and status.
        body: opening ? opening.message : null,
        updates: chronological.map((update) => makeUpdate({
            id: update.id,
            state: update.status ?? null,
            body: update.message,
            createdAt: update.created_at,
        })),
    };
};

const componentRefs = (components = []) => components.map((component) => ({
    id: component.id,
    name: component.name,
    status: component.status ? normalizeStatus(component.status) : null,
}));

const incidentToAlert = (incident, base) => {
    const { body, updates } = splitUpdates(incident.updates);

    return makeAlert({
        id: incident.id,
        kind: ALERT_KIND.INCIDENT,
        url: `${base}/incidents/${incident.id}`,
        title: incident.title,
        body,
        format: BODY_FORMAT.MARKDOWN,
        severity: incident.severity ?? null,
        state: incident.status ?? null,
        startedAt: incident.started_at,
        endedAt: incident.resolved_at ?? null,
        components: componentRefs(incident.affected_components),
        updates,
    });
};

/**
 * A standing advisory.
 *
 * It carries NO severity and NO state, deliberately. The Cloud is explicit that a notice makes
 * no claim about the platform (see IncidentKind.php): it must never be coloured like an outage
 * and never ping an on-call role. Dropping the fields here is what makes that unrepresentable
 * downstream rather than a rule a renderer has to remember.
 */
const noticeToAlert = (notice, base) => {
    const { body, updates } = splitUpdates(notice.updates);

    return makeAlert({
        id: notice.id,
        kind: ALERT_KIND.NOTICE,
        url: `${base}/incidents/${notice.id}`,
        title: notice.title,
        body,
        format: BODY_FORMAT.MARKDOWN,
        severity: null,
        state: null,
        startedAt: notice.started_at,
        components: componentRefs(notice.affected_components),
        updates,
    });
};

const maintenanceToAlert = (maintenance, base) => {
    const { body, updates } = splitUpdates(maintenance.updates);

    return makeAlert({
        id: maintenance.id,
        kind: ALERT_KIND.MAINTENANCE,
        url: `${base}/maintenances/${maintenance.id}`,
        title: maintenance.title,
        body,
        format: BODY_FORMAT.MARKDOWN,
        severity: null,
        state: maintenance.status ?? null,
        startedAt: maintenance.started_at ?? maintenance.scheduled_start,
        endedAt: maintenance.scheduled_end ?? null,
        // `scheduled_end: null` means "until further notice" — never format it as a date.
        window: { start: maintenance.scheduled_start, end: maintenance.scheduled_end ?? null },
        components: componentRefs(maintenance.affected_components),
        updates,
    });
};

/**
 * Build the DTO from a `/full` payload.
 *
 * @param {object} payload
 * @param {object} statuspage - the Statuspage row (for `url`)
 */
export const toSnapshot = (payload, statuspage) => {
    const base = statuspage.url.replace(/\/+$/, '');
    const meta = payload?.meta ?? {};
    const components = payload?.components ?? [];
    const incidents = payload?.active_incidents ?? [];
    const notices = payload?.notices ?? [];
    const maintenances = payload?.maintenances ?? {};
    const active = maintenances.active ?? [];
    const scheduled = maintenances.scheduled ?? [];

    const alerts = [
        ...incidents.map((incident) => incidentToAlert(incident, base)),
        ...active.map((maintenance) => maintenanceToAlert(maintenance, base)),
        ...scheduled.map((maintenance) => maintenanceToAlert(maintenance, base)),
        ...notices.map((notice) => noticeToAlert(notice, base)),
    ];

    return makeSnapshot({
        source: SOURCE.CLOUD,
        url: base,
        name: meta.name ?? statuspage.name,
        // Prefer a server-computed indicator when the payload carries one — the purpose-built
        // public route is expected to — and fall back to the transcribed fold otherwise.
        overall: payload?.status?.indicator
            ?? foldPageStatus(components, incidents, active.length > 0),
        defaultLocale: meta.default_locale ?? 'en',
        locales: meta.supported_locales ?? [],
        groups: flattenTree(components),
        alerts,
    });
};

/**
 * Recover ONE alert that has dropped out of the live payload, by id.
 *
 * WHY THIS EXISTS
 *
 * The Cloud removes an incident from `active_incidents` the instant it is resolved, and a
 * finished maintenance window leaves `maintenances.active` the same way. For the page that is
 * correct. For anything that has been reporting the alert it leaves a hole: the last thing it
 * saw was "we are monitoring", and the update that matters most — "resolved" — never arrives.
 *
 * The detail endpoints still serve those rows in full, so one targeted request closes the gap.
 * The kind is not known from an id alone, so incidents are tried first and maintenances
 * second; each alert is looked up at most once, and only when it has actually disappeared.
 *
 * A 404 is an ANSWER, not an error: with `show_incident_history` disabled the page makes a
 * resolved incident deliberately unreachable. `null` then means "cannot confirm" and the
 * caller must leave its thread on the last state it legitimately saw rather than invent an
 * ending. (Maintenance windows are not gated that way and stay recoverable either way.)
 *
 * @param {object} statuspage - Statuspage row (needs `url`; `externalId` skips a request)
 * @param {string} alertId
 * @returns {Promise<object|null>} DTO alert, or null when it cannot be confirmed
 */
export const fetchClosedAlert = async (statuspage, alertId, expectedKind = null) => {
    const base = statuspage.url.replace(/\/+$/, '');
    const client = new LIVCKCloud(statuspage.url, statuspage.externalId || null);

    const notFound = (error) => error?.status === 404;

    try {
        const payload = await client.fetchIncident(alertId);
        const incident = payload?.data ?? payload;

        if (incident?.id) {
            // A NOTICE COMES BACK THROUGH THE SAME DOOR.
            //
            // The live listing keeps the two apart: it applies a service-state filter
            // precisely so a notice never appears with a severity badge. The detail endpoint
            // has no such filter, so a closed notice is returned shaped like an incident —
            // with a severity — and rendering it that way turned a standing advisory
            // ("phishing mails are going around") RED with an outage severity days after it
            // was posted, by editing the very message that had been calm and blurple.
            //
            // The kind the bot originally saw is the authority. `notice` beats whatever the
            // payload claims; the payload decides only when the caller had no expectation.
            const kind = expectedKind ?? (incident.kind === 'notice' ? ALERT_KIND.NOTICE : ALERT_KIND.INCIDENT);

            return kind === ALERT_KIND.NOTICE
                ? noticeToAlert(incident, base)
                : incidentToAlert(incident, base);
        }
    } catch (error) {
        if (!notFound(error)) throw error;
    }

    try {
        const payload = await client.fetchMaintenance(alertId);
        const maintenance = payload?.data ?? payload;
        if (maintenance?.id) return maintenanceToAlert(maintenance, base);
    } catch (error) {
        if (!notFound(error)) throw error;
    }

    return null;
};

/**
 * Provider interface: fetch and normalize.
 *
 * @param {object} statuspage - Statuspage row (needs `url`; `externalId` skips a request)
 * @returns {Promise<{snapshot: object, pageId: string}>}
 */
export const fetchSnapshot = async (statuspage) => {
    const client = new LIVCKCloud(statuspage.url, statuspage.externalId || null);
    const payload = await client.fetchFull();

    return {
        snapshot: toSnapshot(payload, statuspage),
        // Returned so the caller can persist it and skip the /status.json lookup next time.
        pageId: client.pageId,
    };
};

export default { fetchSnapshot, fetchClosedAlert, toSnapshot, flattenTree, splitUpdates, normalizeStatus };
