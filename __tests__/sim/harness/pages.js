/**
 * LIVCK Cloud status pages on 127.0.0.1, whose state a scenario changes as it goes.
 *
 * Each page lives under its own path (`/p/<slug>`) and answers exactly what the Cloud answers:
 * the `server: LIVCK Cloud` header the detection reads, `/status.json` for the page id, the
 * `full` payload, and the two detail endpoints the close-out asks — with the Cloud's rules for
 * when those 404 (see providers/cloud.js). Updates are kept newest first, as the API sends them.
 *
 * A scenario says what happens on the page — an incident opens, gets an update, resolves, is
 * deleted; a component goes down; the page itself stops answering — and this serves it. The
 * page also counts what it was asked, so a scenario can tell when the bot hammers it.
 */

import http from 'node:http';

let counter = 0;
const id = (prefix) => `${prefix}${(counter += 1).toString(36).padStart(6, '0')}`;

const iso = (ms = Date.now()) => new Date(ms).toISOString().replace('Z', '+00:00');

const json = (res, status, body, headers = {}) => {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json', server: 'LIVCK Cloud', 'x-powered-by': 'LIVCK Cloud', ...headers });
    res.end(JSON.stringify(body));
};

/** Incident states in the order an incident goes through them. */
export const INCIDENT_FLOW = ['investigating', 'identified', 'monitoring', 'resolved'];

const statusIndicator = (components) => {
    const leaves = [];
    const walk = (nodes) => nodes.forEach((n) => (n.is_group ? walk(n.children ?? []) : leaves.push(n.status)));
    walk(components);
    for (const s of ['major_outage', 'partial_outage', 'degraded', 'under_maintenance']) {
        if (leaves.includes(s)) return s;
    }
    return 'operational';
};

/**
 * @param {object} [options]
 * @param {boolean} [options.root] - serve ONE page at the root of its own server, the way a
 *   customer's page lives at `https://status.example.com` and is pasted into /livck subscribe
 *   (which keeps scheme, host and port, and drops any path)
 */
export const startSimPages = async ({ root = false } = {}) => {
    /** slug → page */
    const pages = new Map();
    const log = [];
    let base = null;

    const server = http.createServer((req, res) => {
        const url = req.url.replace(/\?.*$/, '');
        const match = root ? [null, [...pages.keys()][0], url] : url.match(/^\/p\/([^/]+)(\/.*)?$/);
        const page = match ? pages.get(match[1]) : null;
        const path = match?.[2] ?? '/';
        log.push({ at: Date.now(), slug: match?.[1], path });

        if (!page) return json(res, 404, { message: 'Not found' }, { server: 'nginx', 'x-powered-by': '' });
        page.requests += 1;

        if (page.mode === 'hang') return undefined;
        if (page.mode === 'down') return req.socket.destroy();
        if (page.mode === 'error') return json(res, 500, { message: 'Server Error' });

        if (path === '/' || path === '') {
            res.writeHead(200, { 'content-type': 'text/html', server: 'LIVCK Cloud', 'x-powered-by': 'LIVCK Cloud' });
            return res.end('<!doctype html><title>status</title>');
        }
        if (path === '/status.json') {
            return json(res, 200, {
                page: { id: page.pageId, name: page.name.de, url: page.url, locale: 'de', updated_at: iso() },
                status: { indicator: statusIndicator(page.components), description: '' },
                components: [],
            });
        }
        const api = path.match(/^\/api\/statuspage\/([^/]+)\/(full|incidents\/([^/]+)|maintenances\/([^/]+))$/);
        if (!api || api[1] !== page.pageId) return json(res, 404, { message: 'Not found' });

        if (api[2] === 'full') return json(res, 200, fullOf(page));

        if (api[3]) {
            page.detailRequests += 1;
            const incident = page.incidents.get(api[3]);
            const reachable = incident && !incident.removed
                && (incident.status !== 'resolved' || page.showHistory);
            return reachable ? json(res, 200, { data: publicIncident(incident) }) : json(res, 404, { message: 'Not found' });
        }
        if (api[4]) {
            page.detailRequests += 1;
            const maintenance = page.maintenances.get(api[4]);
            return maintenance && !maintenance.removed
                ? json(res, 200, { data: publicMaintenance(maintenance) })
                : json(res, 404, { message: 'Not found' });
        }
        return json(res, 404, { message: 'Not found' });
    });

    const publicIncident = (incident) => ({
        id: incident.id,
        title: incident.title,
        severity: incident.severity,
        status: incident.status,
        started_at: incident.startedAt,
        resolved_at: incident.resolvedAt,
        updates: [...incident.updates].reverse(),
        affected_components: [],
        affected_services: [],
        attachments: [],
        postmortem: null,
    });

    const publicMaintenance = (maintenance) => ({
        id: maintenance.id,
        title: maintenance.title,
        status: maintenance.status,
        scheduled_start: maintenance.scheduledStart,
        scheduled_end: maintenance.scheduledEnd,
        started_at: maintenance.status === 'scheduled' ? null : maintenance.scheduledStart,
        completed_at: maintenance.status === 'completed' ? iso() : null,
        updates: [...maintenance.updates].reverse(),
        affected_components: [],
        affected_services: [],
    });

    const fullOf = (page) => {
        const live = [...page.incidents.values()].filter((i) => !i.removed && i.status !== 'resolved');
        // What the bot can know about at all: an incident that resolved before any `full` served
        // it was never announced anywhere, and nothing should appear for it.
        live.forEach((incident) => { incident.seenLive = true; });
        const maint = [...page.maintenances.values()].filter((m) => !m.removed);
        return {
            meta: {
                id: page.pageId, name: page.name, slug: page.slug,
                supported_locales: ['de', 'en'], default_locale: 'de',
                show_incident_history: page.showHistory, access_type: 'public',
            },
            components: page.components,
            active_incidents: live.map(publicIncident),
            notices: [],
            maintenances: {
                active: maint.filter((m) => m.status === 'in_progress').map(publicMaintenance),
                scheduled: maint.filter((m) => m.status === 'scheduled').map(publicMaintenance),
            },
            metrics: [],
        };
    };

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;

    const leaf = (name, status = 'operational') => ({
        id: id('c'), name: { de: name, en: name }, description: null, status,
        is_visible: true, is_group: false, show_uptime_bars: false, hide_operational_children: false, default_open: true,
    });

    const group = (name, children) => ({
        id: id('g'), name: { de: name, en: name }, description: null, status: 'operational',
        is_visible: true, is_group: true, show_uptime_bars: false, hide_operational_children: false,
        default_open: true, children,
    });

    const sim = {
        log,

        /**
         * A page with `services` components in `groups` groups, all operational.
         * @returns {string} slug
         */
        addPage({ name, groups = 2, services = 4, showHistory = true } = {}) {
            const slug = id('page');
            const title = name ?? `Sim ${slug}`;
            const perGroup = Math.max(1, Math.ceil(services / groups));
            const components = Array.from({ length: groups }, (_, g) => group(
                `Gruppe ${g + 1}`,
                Array.from({ length: perGroup }, (_, s) => leaf(`Dienst ${g + 1}.${s + 1}`)),
            ));
            pages.set(slug, {
                slug, pageId: id('pg'), name: { de: title, en: title }, url: root ? base : `${base}/p/${slug}`,
                components, incidents: new Map(), maintenances: new Map(), showHistory,
                mode: 'ok', requests: 0, detailRequests: 0,
            });
            return slug;
        },

        url: (slug) => (root ? base : `${base}/p/${slug}`),
        owns: (url) => url === base || url.startsWith(`${base}/`),
        /** Which page a subscribed URL is, and on which server. */
        locate: (url) => ({ slug: root ? [...pages.keys()][0] : url.split('/p/')[1], pages: sim }),
        page: (slug) => pages.get(slug),
        pages: () => [...pages.keys()],

        /** Every leaf of a page, flat. */
        services(slug) {
            const out = [];
            const walk = (nodes) => nodes.forEach((n) => (n.is_group ? walk(n.children) : out.push(n)));
            walk(pages.get(slug).components);
            return out;
        },

        setService(slug, index, status) {
            sim.services(slug)[index].status = status;
        },

        /** Open an incident with its first update. @returns {string} incident id */
        openIncident(slug, { title, severity = 'major', message, startedAt = Date.now() } = {}) {
            const page = pages.get(slug);
            const incidentId = id('inc');
            // The id in the title keeps every title unique and none a prefix of another, so a
            // message can be told apart by its title alone.
            const incident = {
                id: incidentId,
                title: { de: title ?? `Störung [${incidentId}]`, en: title ?? `Outage [${incidentId}]` },
                severity, status: 'investigating', startedAt: iso(startedAt), resolvedAt: null, updates: [], removed: false,
            };
            page.incidents.set(incident.id, incident);
            sim.updateIncident(slug, incident.id, { status: 'investigating', message: message ?? `${incident.title.de}: wir schauen uns das an` });
            return incident.id;
        },

        /** One more update. Its text is unique, so a duplicate is always visible as one. */
        updateIncident(slug, incidentId, { status, message } = {}) {
            const incident = pages.get(slug).incidents.get(incidentId);
            // Never resolves by itself: an ending is a decision the scenario makes (resolveIncident).
            const next = status ?? INCIDENT_FLOW[Math.min(INCIDENT_FLOW.indexOf(incident.status) + 1, 2)];
            const text = message ?? `${incident.title.de} — Update ${incident.updates.length + 1} (${next})`;
            incident.updates.push({ id: id('u'), status: next, message: { de: text, en: text }, created_at: iso() });
            incident.status = next;
            if (next === 'resolved') incident.resolvedAt = iso();
        },

        resolveIncident(slug, incidentId, message) {
            sim.updateIncident(slug, incidentId, { status: 'resolved', message });
        },

        /** Correct the text of an update after it was posted. */
        editUpdate(slug, incidentId, index, text) {
            const update = pages.get(slug).incidents.get(incidentId).updates[index];
            update.message = { de: text, en: text };
        },

        /** The operator takes it off the page. */
        removeIncident(slug, incidentId) {
            pages.get(slug).incidents.get(incidentId).removed = true;
        },

        incidents: (slug) => [...pages.get(slug).incidents.values()],

        setMode(slug, mode) { pages.get(slug).mode = mode; },

        async close() {
            server.closeAllConnections?.();
            await new Promise((resolve) => server.close(resolve));
        },
    };

    return sim;
};

export default startSimPages;
