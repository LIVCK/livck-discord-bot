import StatuspageService from '../services/statuspage.js';
import LIVCK from '../api/livck.js';
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
 * Adapter for a self-hosted LIVCK instance.
 *
 * Maps the v3/v1 API into the shared DTO. The status vocabulary of a self-hosted page is a
 * subset of the Cloud's, so this maps UP: three values become three of the Cloud's six.
 *
 * THE ROLLUP RULES ARE TRANSCRIBED, NOT REPLACED
 *
 * Group and overall status are derived exactly as messages/layoutRenderers.js used to derive
 * them, only in the new vocabulary. Applying the Cloud's own rollup here instead would be
 * defensible in the abstract and WRONG in practice: the Cloud folds a group with one dead and
 * one healthy service to `partial_outage` (amber), while this page has always shown it red.
 * Changing the colour of thousands of live status messages is not a refactor. The Cloud
 * adapter does not derive anything — it takes the statuses the server already computed.
 */

/** Self-hosted monitor state → DTO status. */
const SERVICE_STATUS = {
    AVAILABLE: STATUS.OPERATIONAL,
    UNAVAILABLE: STATUS.MAJOR_OUTAGE,
    DEGRADED: STATUS.DEGRADED,
    MAINTENANCE: STATUS.UNDER_MAINTENANCE,
};

export const mapServiceState = (state) => SERVICE_STATUS[state] ?? STATUS.UNKNOWN;

/**
 * Group status, transcribed from the former `getCategoryStatus`:
 * all up → operational; any down → major_outage; anything else → degraded.
 * An empty group counts as operational, as it always has.
 */
export const groupStatus = (services) => {
    if (!services || services.length === 0) return STATUS.OPERATIONAL;
    if (services.every((service) => service.status === STATUS.OPERATIONAL)) return STATUS.OPERATIONAL;
    if (services.some((service) => service.status === STATUS.MAJOR_OUTAGE)) return STATUS.MAJOR_OUTAGE;
    return STATUS.DEGRADED;
};

/**
 * Overall status, transcribed from the former `getOverallStatus`: it folds over every SERVICE
 * on the page, not over the group statuses — all up → operational, none up → major_outage,
 * anything in between → degraded.
 */
export const overallStatus = (groups) => {
    const services = groups.flatMap((group) => group.services);
    if (services.length === 0) return STATUS.OPERATIONAL;

    const up = services.filter((service) => service.status === STATUS.OPERATIONAL).length;
    if (up === services.length) return STATUS.OPERATIONAL;
    if (up === 0) return STATUS.MAJOR_OUTAGE;
    return STATUS.DEGRADED;
};

/**
 * Self-hosted alerts are one flat concept distinguished by `type`; the DTO splits them by
 * kind so a maintenance window is not rendered as an outage.
 */
const alertKind = (alert) => {
    if (alert.type === 'INCIDENT') return ALERT_KIND.INCIDENT;
    if (alert.scheduled_for) return ALERT_KIND.MAINTENANCE;
    return ALERT_KIND.NOTICE;
};

const toAlert = (alert) => makeAlert({
    id: alert.id,
    kind: alertKind(alert),
    url: alert.link,
    title: alert.title,
    body: alert.message,
    format: BODY_FORMAT.HTML,
    severity: alert.type === 'INCIDENT' ? 'major' : null,
    state: alert.state ?? null,
    startedAt: alert.created_at,
    endedAt: alert.scheduled_until ?? null,
    window: alert.scheduled_for
        ? { start: alert.scheduled_for, end: alert.scheduled_until ?? null }
        : null,
    components: (alert.monitors || []).map((monitor) => ({
        id: monitor.id,
        name: monitor.name,
        status: null,
    })),
    // Sub-alerts are the timeline. They arrive oldest-first here, which is the DTO's order.
    updates: (alert.alerts || []).map((update) => makeUpdate({
        id: update.id,
        title: update.title ?? null,
        state: update.state ?? null,
        body: update.message,
        createdAt: update.created_at,
    })),
});

/** Build the DTO from an already-fetched StatuspageService. */
export const toSnapshot = (service, statuspage) => {
    const groups = (service.categories || []).map((category) => {
        const services = (Array.isArray(category.monitors) ? category.monitors : []).map((monitor) => makeService({
            id: monitor.id,
            name: monitor.name,
            description: monitor.short_description ?? null,
            status: mapServiceState(monitor.state),
        }));

        return makeGroup({
            id: category.id,
            name: category.name,
            description: category.short_description ?? null,
            status: groupStatus(services),
            depth: 0,
            path: [],
            services,
        });
    });

    return makeSnapshot({
        source: SOURCE.SELF_HOSTED,
        url: statuspage.url,
        name: statuspage.name,
        overall: overallStatus(groups),
        // The server renders one language per request (Accept-Language), so the payload is
        // already in the subscription's locale — there is nothing left to resolve.
        defaultLocale: 'en',
        locales: [],
        groups,
        alerts: (service.alerts || []).map(toAlert),
    });
};

/**
 * Provider interface: fetch and normalize.
 *
 * @param {object} statuspage - Statuspage row (needs `url`, `name`)
 * @param {object} options
 * @param {string|null} [options.token] - subscription API token, for a private page
 * @param {string} [options.locale]
 * @param {boolean} [options.withAlerts]
 * @returns {Promise<object>} snapshot
 */
export const fetchSnapshot = async (statuspage, { token = null, locale = 'de', withAlerts = true } = {}) => {
    const service = new StatuspageService(new LIVCK(statuspage.url, 'v3', token, locale));

    if (withAlerts) {
        await service.fetchAll();
    } else {
        await service.fetchCategories();
    }

    return toSnapshot(service, statuspage);
};

export default { fetchSnapshot, toSnapshot, groupStatus, overallStatus, mapServiceState };
