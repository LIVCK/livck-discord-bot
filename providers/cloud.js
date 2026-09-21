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

/**
 * Status values the Cloud can send. Anything else is treated as unknown rather than assumed up.
 *
 * Exported so tests can derive their inputs from it instead of retyping the list. A hand-typed
 * copy drifted once already: it said `degraded_performance`, which is Atlassian's spelling and
 * not a value in LIVCK's `ComponentStatus` enum. Every payload built from that list therefore
 * carried a status the adapter rejects, so `degraded` — a first-class state a customer's page
 * really shows — had never once been rendered by a test, while `unknown` was being exercised
 * under its name.
 */
export const KNOWN_STATUSES = new Set([
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
            const before = out.length;
            collectLeaves(node.children, [...path, node.name], out);

            // A NESTED GROUP THAT YIELDED NOTHING STILL HAS TO SHOW UP.
            //
            // When a group hides its healthy children the server prunes them, so `children`
            // comes back empty and recursing past it left nothing behind — the group, its
            // name and its rolled-up status all vanished. A page laid out as
            // `Region EU > Gameserver (hides 66 healthy children)` therefore rendered as
            // "Region EU — Keine Dienste vorhanden." while the customer's own page showed
            // "Gameserver — operational". Only TOP-LEVEL hiding groups were handled.
            //
            // One line, carrying exactly what the public page carries: the group's name and
            // its own status. Never a count — how many services sit behind a hiding group is
            // precisely what it is hiding. If some of its children ARE affected they came
            // through the recursion above and are listed individually, which is the more
            // useful answer, so the summary line is only added when there was nothing.
            if (out.length === before) {
                out.push(makeService({
                    id: node.id,
                    name: node.name,
                    description: node.description ?? null,
                    status: normalizeStatus(node.status),
                    path,
                }));
            }
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
        // Read ONLY to decide whether a 404 from a detail endpoint proves removal. A payload
        // from an older edge build has no such key; `null` is kept as "did not say" rather
        // than folded into `false`, so the reason is visible where it is used.
        showIncidentHistory: typeof meta.show_incident_history === 'boolean'
            ? meta.show_incident_history
            : null,
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
 * A 404 is an ANSWER, not an error — but WHICH answer depends on the endpoint, and the two
 * are not filtered alike. Straight from the source of truth
 * (`Domains/Edge/Controllers/InternalApi/StatuspageApiController.php`):
 *
 *   maintenanceDetail  where public_id, whereHas(statuspages)
 *   incidentDetail     ... plus is_published = true
 *                      ... plus whereNull(resolved_at) WHEN show_incident_history is off
 *
 * So a 404 from the maintenance endpoint has exactly one cause: the window is no longer on
 * this page. A 404 from the incident endpoint has that cause too — deleted, unpublished, or
 * unlinked, which are all "the operator took it off the page" — but with the history switched
 * off it ALSO fires for an incident that is merely resolved and still very much exists.
 *
 * `removed` is that distinction, and it is what the caller DELETES a customer's thread on, so
 * it is only ever true when the 404 can mean nothing else:
 *
 *   maintenance      the maintenance endpoint 404s
 *   anything else    both endpoints 404 AND the page shows its incident history
 *
 * `historyVisible` is `snapshot.showIncidentHistory`. `null` — an edge build that does not
 * send the flag — is refused exactly like `false`; the bot does not guess about a delete.
 *
 * A response that is neither a hit nor a 404 (200 without an id, a transport failure) proves
 * nothing either: the first falls through as `removed: false`, the second throws.
 *
 * @param {object} statuspage - Statuspage row (needs `url`; `externalId` skips a request)
 * @param {string} alertId
 * @param {string|null} [expectedKind] - the kind the bot originally saw
 * @param {{historyVisible?: boolean|null}} [options]
 * @returns {Promise<{alert: object|null, removed: boolean}>} the alert when it is still
 *   reachable; otherwise `alert: null` with `removed` saying whether it is provably gone
 */
export const fetchClosedAlert = async (
    statuspage,
    alertId,
    expectedKind = null,
    { historyVisible = null } = {},
) => {
    const base = statuspage.url.replace(/\/+$/, '');
    const client = new LIVCKCloud(statuspage.url, statuspage.externalId || null);

    const notFound = (error) => error?.status === 404;

    // Set ONLY by a real 404. A malformed 200 leaves them false and proves nothing.
    let incidentGone = false;
    let maintenanceGone = false;

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

            return {
                alert: kind === ALERT_KIND.NOTICE
                    ? noticeToAlert(incident, base)
                    : incidentToAlert(incident, base),
                removed: false,
            };
        }
    } catch (error) {
        if (!notFound(error)) throw error;
        incidentGone = true;
    }

    try {
        const payload = await client.fetchMaintenance(alertId);
        const maintenance = payload?.data ?? payload;
        if (maintenance?.id) return { alert: maintenanceToAlert(maintenance, base), removed: false };
    } catch (error) {
        if (!notFound(error)) throw error;
        maintenanceGone = true;
    }

    const removed = expectedKind === ALERT_KIND.MAINTENANCE
        ? maintenanceGone
        : incidentGone && maintenanceGone && historyVisible === true;

    return { alert: null, removed };
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
