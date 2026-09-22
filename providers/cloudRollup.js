import { STATUS } from '../dto/statuspage.js';

/**
 * The Cloud's page-level status rollup, transcribed.
 *
 * PARITY CONTRACT
 *
 * This mirrors three things that already agree with each other on the Cloud side:
 *   laravel  app/Domains/Statuspages/Services/LoadComponentTreeService::computeGroupStatus()
 *   edge     shared/utils/overall-status.ts  (computeRootGroupStatus / applyIncidentFloor /
 *            applyMaintenanceRescue)
 *   edge     the `status.indicator` field of /status.json
 *
 * WHY TRANSCRIBE INSTEAD OF ASK
 *
 * `/api/statuspage/{id}/full` — the one request that carries every locale, every component and
 * the update timelines — does NOT include the folded indicator; only `/status.json` does, and
 * that one lacks the update bodies. Asking for both would double the request count per status
 * page per cycle, against an edge budget of 300 requests a minute shared across every Cloud
 * page the bot watches.
 *
 * The risk of a third copy drifting is answered by a test rather than by discipline:
 * __tests__/providers/cloudRollup.live.test.js folds a real page's component tree and asserts
 * the result equals what that same page's /status.json reports. Run it with
 * LIVCK_LIVE_TESTS=1.
 *
 * When the purpose-built public route lands and carries `status.indicator`, `foldPageStatus`
 * below becomes a fallback — see providers/cloud.js, which already prefers a server-supplied
 * indicator when one is present.
 */

/** Severity ladder. `unknown` deliberately ties with `operational`: it is neutral, not bad. */
const SEVERITY = {
    [STATUS.OPERATIONAL]: 0,
    [STATUS.UNKNOWN]: 0,
    [STATUS.UNDER_MAINTENANCE]: 1,
    [STATUS.DEGRADED]: 2,
    [STATUS.PARTIAL_OUTAGE]: 3,
    [STATUS.MAJOR_OUTAGE]: 4,
};

const severityOf = (status) => SEVERITY[status] ?? 0;

/**
 * Fold a set of sibling statuses the way the Cloud folds a component group.
 *
 * @param {string[]} statuses
 * @returns {string}
 */
export const foldGroup = (statuses) => {
    // An empty page is unknown, never fail-green.
    if (!statuses || statuses.length === 0) return STATUS.UNKNOWN;

    // (a) everything unknown → unknown ("data delayed")
    if (statuses.every((s) => s === STATUS.UNKNOWN)) return STATUS.UNKNOWN;

    // (b) everything major → major. Any non-major sibling — including an unknown or a
    // maintained one — breaks the collapse: excluding maintained nodes here would let
    // starting a maintenance window ESCALATE partial → major.
    if (statuses.every((s) => s === STATUS.MAJOR_OUTAGE)) return STATUS.MAJOR_OUTAGE;

    const worst = statuses.reduce((a, b) => (severityOf(b) > severityOf(a) ? b : a));

    // (c) nothing worse than degraded → degraded, not overstated
    if (worst === STATUS.DEGRADED) return STATUS.DEGRADED;

    // (d) nothing worse than a maintained node → under_maintenance
    if (worst === STATUS.UNDER_MAINTENANCE) return STATUS.UNDER_MAINTENANCE;

    // (e) any real failure (but not all-major) → partial_outage. unknown and
    // under_maintenance are neutral and never invent an outage.
    if (statuses.some((s) => s !== STATUS.OPERATIONAL && s !== STATUS.UNKNOWN && s !== STATUS.UNDER_MAINTENANCE)) {
        return STATUS.PARTIAL_OUTAGE;
    }

    // (f) operational + unknown, with at least one operational
    return STATUS.OPERATIONAL;
};

/** An incident's severity, as the status it claims for the page. */
const INCIDENT_FLOOR = {
    critical: STATUS.MAJOR_OUTAGE,
    major: STATUS.PARTIAL_OUTAGE,
    minor: STATUS.DEGRADED,
};

/**
 * Raise the page status to what an active incident claims, when the components do not already
 * say something worse.
 *
 * This exists because an incident with no component links used to move nothing: "all systems
 * operational" would sit directly above a critical incident. That happens for exactly the
 * incidents that matter most — a power failure, a fire next door — where nobody tags fifty
 * services one by one. An incident can only ever RAISE the floor, never lower the components'
 * verdict.
 */
export const applyIncidentFloor = (base, incidents = []) => {
    if (incidents.length === 0) return base;

    const floor = incidents.reduce((worst, incident) => {
        const mapped = INCIDENT_FLOOR[incident.severity ?? ''] ?? STATUS.DEGRADED;
        return severityOf(mapped) > severityOf(worst) ? mapped : worst;
    }, base);

    return severityOf(floor) > severityOf(base) ? floor : base;
};

/** Maintenance only rescues an otherwise healthy or unknown page. */
export const applyMaintenanceRescue = (base, hasActiveMaintenance) => {
    if (hasActiveMaintenance && (base === STATUS.OPERATIONAL || base === STATUS.UNKNOWN)) {
        return STATUS.MAINTENANCE;
    }
    return base;
};

/**
 * The page indicator.
 *
 * Folds the TOP-LEVEL nodes only — never the flattened list, which would count a group and its
 * children twice. Group nodes arrive with the status Laravel already rolled up bottom-up.
 * Order matters: components first, then the floor an incident claims, then the maintenance
 * rescue — the rescue must only ever see a page that is genuinely calm.
 *
 * @param {Array} topLevel - the component tree's root nodes
 * @param {Array} activeIncidents
 * @param {boolean} hasActiveMaintenance
 */
export const foldPageStatus = (topLevel = [], activeIncidents = [], hasActiveMaintenance = false) => {
    const statuses = topLevel
        .filter((node) => node.is_visible !== false)
        .map((node) => node.status);

    return applyMaintenanceRescue(
        applyIncidentFloor(foldGroup(statuses), activeIncidents),
        hasActiveMaintenance
    );
};

export default { foldGroup, foldPageStatus, applyIncidentFloor, applyMaintenanceRescue };
