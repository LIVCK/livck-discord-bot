import { HttpError } from '../util/errors.js';

/**
 * Client for a LIVCK Cloud status page.
 *
 * WHICH SURFACE THIS USES, AND WHY NOT THE OTHERS
 *
 * - `api.livck.cloud/v1` is a management API (create incidents, manage services, on-call).
 *   It has no public read endpoint for "the state of this page", and using it would require
 *   every Discord customer to hand the bot an organization token with write access to their
 *   whole account.
 * - `history.rss` / `history.atom` are published in the page's DEFAULT locale only, and their
 *   summaries are markdown already flattened to plain text. Subscriptions are per-channel
 *   bilingual and the bot renders markdown itself, so both properties are lost.
 * - `/status.json` is public and stable but carries no update bodies and no links, and costs
 *   one request per language.
 *
 * So: `/status.json` once to learn the page id (cacheable for the lifetime of the page), then
 * `/api/statuspage/{id}/full`, which returns every locale, every component, and the update
 * timelines in a single request.
 *
 * `/full` is the Edge's own SSR contract rather than a published API. It is public for a
 * public page and stable in practice, but the intent is to replace this with one purpose-built
 * public route (`/status.full.json`) — at which point only `fetchFull()` below changes.
 */

const REQUEST_TIMEOUT_MS = Number(process.env.LIVCK_TIMEOUT_MS || 10_000);

export default class LIVCKCloud {

    /**
     * @param {string} baseUrl - page origin, e.g. `https://status.emeraldhost.de`
     * @param {string|null} [pageId] - known page id, to skip the /status.json lookup
     */
    constructor(baseUrl, pageId = null) {
        this.baseURL = baseUrl.replace(/\/+$/, '');
        this.pageId = pageId || null;
    }

    async request(path) {
        const url = `${this.baseURL}${path}`;

        const response = await fetch(url, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (!response.ok) {
            throw new HttpError(response.status, response.statusText, url);
        }

        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            throw new Error(`Expected JSON response, got: ${contentType}`);
        }

        return response.json();
    }

    /**
     * Public snapshot. Also the cheapest way to learn the page id.
     *
     * A protected page (`access_type !== 'public'`) answers 404 here — deliberately, so an
     * unauthenticated URL cannot confirm that a private page exists.
     */
    async fetchStatus() {
        return this.request('/status.json');
    }

    /** Resolve and remember the page id. */
    async resolvePageId() {
        if (this.pageId) return this.pageId;

        const status = await this.fetchStatus();
        const id = status?.page?.id;

        if (!id) {
            throw new Error(`No page id in ${this.baseURL}/status.json`);
        }

        this.pageId = id;
        return id;
    }

    /** Everything the bot renders: meta, component tree, incidents, notices, maintenances. */
    async fetchFull() {
        const id = await this.resolvePageId();
        return this.request(`/api/statuspage/${id}/full`);
    }

    /**
     * One incident by id, in ANY status.
     *
     * This is how a closed-out incident is recovered: the Cloud drops it from
     * `active_incidents` the moment it resolves, but the detail endpoint still serves it with
     * its full timeline — including the "resolved" update that never reached `full`.
     *
     * 404 is a legitimate answer, not a failure: with `show_incident_history` disabled the
     * page deliberately makes a RESOLVED incident unreachable here too. The caller must treat
     * that as "cannot confirm" and claim nothing.
     */
    async fetchIncident(incidentId) {
        const id = await this.resolvePageId();
        return this.request(`/api/statuspage/${id}/incidents/${incidentId}`);
    }

    /**
     * One maintenance window by id, in ANY status.
     *
     * Unlike the incident endpoint this is NOT gated on `show_incident_history` — the
     * "maintenance completed" subscriber mail links straight here, so the link has to keep
     * working. A finished window is therefore always recoverable.
     */
    async fetchMaintenance(maintenanceId) {
        const id = await this.resolvePageId();
        return this.request(`/api/statuspage/${id}/maintenances/${maintenanceId}`);
    }

    /**
     * Resolved incidents and terminal maintenance windows, newest first, paginated.
     *
     * Needed because the Cloud drops an incident from `active_incidents` the moment it is
     * resolved: without this the bot would never see the "resolved" update and a Discord
     * thread would sit on "we are monitoring" forever.
     *
     * Returns an empty page when the operator disabled the public history — which is exactly
     * why this is a fallback and not the primary mechanism.
     */
    async fetchHistory(page = 1) {
        const id = await this.resolvePageId();
        return this.request(`/api/statuspage/${id}/history/${page}`);
    }
}
