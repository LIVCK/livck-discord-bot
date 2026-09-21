/**
 * When is "gone from the API" a PROOF that the operator removed it?
 *
 * The bot deletes the Discord thread it posted on that answer, which is irreversible and
 * invisible in scrollback, so the verdict is worth more tests than the happy path it guards.
 *
 * The rule is not invented here — it is read off the Cloud's own queries in
 * `Domains/Edge/Controllers/InternalApi/StatuspageApiController.php`:
 *
 *   maintenanceDetail  where public_id, whereHas(statuspages)
 *   incidentDetail     ... plus is_published = true
 *                      ... plus whereNull(resolved_at) WHEN show_incident_history is off
 *
 * A maintenance 404 therefore has one meaning. An incident 404 has one meaning too — unless
 * the history is off, in which case it also fires for an incident that merely resolved and is
 * still very much there. Every test below is a line of that table.
 */

import { jest } from '@jest/globals';

const api = { incident: null, maintenance: null };

const notFound = () => {
    const error = new Error('HTTP 404: Not Found');
    error.name = 'HttpError';
    error.status = 404;
    return error;
};

const serve = (value) => () => {
    if (value instanceof Error) throw value;
    return value;
};

jest.unstable_mockModule('../../api/livckCloud.js', () => ({
    default: class {
        async fetchIncident() { return serve(api.incident)(); }
        async fetchMaintenance() { return serve(api.maintenance)(); }
    },
}));

const { fetchClosedAlert } = await import('../../providers/cloud.js');
const { ALERT_KIND } = await import('../../dto/statuspage.js');

const page = { url: 'https://status.example.com', externalId: 'page-id' };

const ask = (kind, historyVisible) =>
    fetchClosedAlert(page, 'alert-1', kind, { historyVisible });

beforeEach(() => {
    api.incident = notFound();
    api.maintenance = notFound();
});

describe('a maintenance window', () => {
    // maintenanceDetail filters on nothing but the id and the page link, so there is exactly
    // one reason it can 404. The history switch is not in that query at all.
    test.each([[true], [false], [null]])(
        'a 404 proves removal whatever the history setting is (%s)',
        async (historyVisible) => {
            const verdict = await ask(ALERT_KIND.MAINTENANCE, historyVisible);
            expect(verdict).toEqual({ alert: null, removed: true });
        }
    );

    test('one that is still served is not removed', async () => {
        api.maintenance = { data: { id: 'alert-1', title: { de: 'Wartung' }, status: 'completed' } };

        const { alert, removed } = await ask(ALERT_KIND.MAINTENANCE, true);

        expect(removed).toBe(false);
        expect(alert.id).toBe('alert-1');
    });
});

describe('an incident', () => {
    test('a 404 proves removal when the page shows its history', async () => {
        // With the history on, incidentDetail answers for a resolved incident too. Nothing is
        // being hidden, so the only remaining reason for a 404 is that it is off the page.
        await expect(ask(ALERT_KIND.INCIDENT, true)).resolves.toEqual({ alert: null, removed: true });
    });

    test('a 404 proves NOTHING when the page hides its history', async () => {
        // The incident is resolved and still exists; the page simply refuses to serve it.
        // Reading this as a removal would delete a real outage out of the customer's channel.
        await expect(ask(ALERT_KIND.INCIDENT, false)).resolves.toEqual({ alert: null, removed: false });
    });

    test('a payload that does not carry the flag is refused like a "no"', async () => {
        // An older edge build sends no `show_incident_history`. The bot does not guess about
        // a delete — "did not say" is not "probably on".
        await expect(ask(ALERT_KIND.INCIDENT, null)).resolves.toEqual({ alert: null, removed: false });
        await expect(fetchClosedAlert(page, 'alert-1', ALERT_KIND.INCIDENT))
            .resolves.toEqual({ alert: null, removed: false });
    });

    test('an unknown kind is held to the incident rule, not the maintenance one', async () => {
        // `kind` is NULL on rows written before that column existed. Treating those as
        // maintenances would hand them the weaker test.
        await expect(ask(null, false)).resolves.toEqual({ alert: null, removed: false });
        await expect(ask(null, true)).resolves.toEqual({ alert: null, removed: true });
    });

    test('one that is still served is not removed', async () => {
        api.incident = {
            data: { id: 'alert-1', title: { de: 'Störung' }, status: 'resolved', severity: 'major' },
        };

        const { alert, removed } = await ask(ALERT_KIND.INCIDENT, true);

        expect(removed).toBe(false);
        expect(alert.id).toBe('alert-1');
    });
});

describe('answers that are not answers', () => {
    test('a transport failure throws rather than returning a verdict', async () => {
        // The page being unreachable is the single most likely reason an alert "vanishes",
        // and it says nothing whatsoever about the alert. It must not reach the delete path.
        api.incident = new Error('socket hang up');

        await expect(ask(ALERT_KIND.INCIDENT, true)).rejects.toThrow('socket hang up');
    });

    test('a 500 throws too', async () => {
        const error = new Error('HTTP 500: Server Error');
        error.status = 500;
        api.maintenance = error;

        await expect(ask(ALERT_KIND.MAINTENANCE, true)).rejects.toThrow('HTTP 500');
    });

    test('a 200 without an id proves nothing', async () => {
        // Neither a hit nor a 404. A proxy serving an error page as JSON lands here.
        api.incident = { data: {} };
        api.maintenance = { data: {} };

        await expect(ask(ALERT_KIND.INCIDENT, true)).resolves.toEqual({ alert: null, removed: false });
    });

    test('a maintenance that answers 200 without an id is not removed either', async () => {
        api.maintenance = {};

        await expect(ask(ALERT_KIND.MAINTENANCE, true)).resolves.toEqual({ alert: null, removed: false });
    });
});
