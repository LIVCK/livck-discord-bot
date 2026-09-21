/**
 * Closing out a thread whose alert has left the live payload.
 *
 * The Cloud drops an incident from `active_incidents` the moment it resolves. Without this the
 * last thing a Discord thread ever shows is "we are monitoring", which reads as an ongoing
 * outage long after everything is fine.
 *
 * What matters here is restraint as much as completeness: the bot must close a thread when it
 * can confirm the ending, and must say nothing at all when it cannot.
 */

import { jest } from '@jest/globals';

const provider = { snapshot: null, closed: {}, closedCalls: [] };

jest.unstable_mockModule('../../providers/index.js', () => ({
    fetchSnapshot: async () => provider.snapshot,
    fetchClosedAlert: async (_statuspage, alertId) => {
        provider.closedCalls.push(alertId);
        const value = provider.closed[alertId];
        if (value instanceof Error) throw value;
        return value ?? null;
    },
    resolveSource: async () => 'CLOUD',
    clearSnapshotCache: () => {},
    NotLivckError: class NotLivckError extends Error {},
    default: {},
}));

const db = {};

jest.unstable_mockModule('../../models/index.js', () => ({
    default: {
        Statuspage: { findOne: async () => db.statuspage },
        Subscription: { destroy: async ({ where }) => { db.destroyed.push(where.id); } },
        RoleMention: { findAll: async () => [] },
        Message: {
            findAll: async ({ where }) => db.messages.filter(
                (m) => m.subscriptionId === where.subscriptionId && m.category === where.category
            ),
            findOne: async ({ where }) => db.messages.find(
                (m) => m.subscriptionId === where.subscriptionId
                    && m.category === where.category
                    && m.serviceId === where.serviceId
            ) ?? null,
            // Query-level update: the production code cannot use record.update() for the
            // heartbeat, because Sequelize issues no SQL when nothing changed and updatedAt
            // would never move.
            update: async (values, { where }) => {
                const row = db.messages.find((m) => m.id === where.id);
                if (row) { Object.assign(row, values); row.updatedAt = new Date(); }
                return [row ? 1 : 0];
            },
            create: async (row) => {
                const record = {
                    ...row,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    update: async (fields) => { Object.assign(record, fields); },
                    destroy: async () => { db.messages = db.messages.filter((m) => m !== record); },
                };
                db.messages.push(record);
                return record;
            },
        },
    },
}));

const { handleAlerts, clearCloseoutCooldowns } = await import('../../handlers/handleAlerts.js');
const { ALERT_KIND, BODY_FORMAT, SOURCE, STATUS, makeAlert, makeSnapshot, makeUpdate } =
    await import('../../dto/statuspage.js');

const discord = { sent: [], edits: 0 };

const makeClient = () => ({
    channels: {
        fetch: async (id) => ({
            id,
            send: async (payload) => { discord.sent.push(payload); return { id: `msg-${discord.sent.length}` }; },
            messages: { edit: async () => { discord.edits += 1; return {}; } },
        }),
    },
});

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

const incident = (overrides = {}) => makeAlert({
    id: 'inc-1',
    kind: ALERT_KIND.INCIDENT,
    url: 'https://status.example.com/incidents/inc-1',
    title: { de: 'Störung' },
    body: { de: 'Wir untersuchen das.' },
    format: BODY_FORMAT.MARKDOWN,
    severity: 'major',
    state: 'monitoring',
    startedAt: hoursAgo(5),
    updates: [],
    ...overrides,
});

const snapshotWith = (alerts) => makeSnapshot({
    source: SOURCE.CLOUD,
    url: 'https://status.example.com',
    name: { de: 'Example' },
    overall: STATUS.OPERATIONAL,
    defaultLocale: 'de',
    locales: ['de'],
    groups: [],
    alerts,
});

const trackedMessage = (serviceId, ageHours = 2) => ({
    subscriptionId: 1,
    category: 'NEWS',
    serviceId,
    messageId: 'msg-1',
    contentHash: 'whatever',
    createdAt: new Date(Date.now() - ageHours * 3600 * 1000),
    updatedAt: new Date(Date.now() - ageHours * 3600 * 1000),
    update: async function (f) { Object.assign(this, f); },
    destroy: async () => {},
});

beforeEach(() => {
    // A vanished alert is only re-asked about every CLOSEOUT_RECHECK_MS; the cooldown lives in
    // the module, so consecutive tests reusing an alert id would throttle each other.
    clearCloseoutCooldowns();

    provider.snapshot = snapshotWith([]);
    provider.closed = {};
    provider.closedCalls = [];

    db.statuspage = {
        id: 7,
        url: 'https://status.example.com',
        name: 'Example',
        kind: 'CLOUD',
        externalId: 'page-id',
        save: async () => {},
        Subscriptions: [{
            id: 1,
            channelId: 'chan-1',
            locale: 'de',
            apiToken: null,
            eventTypes: { STATUS: false, NEWS: true },
            createdAt: new Date('2020-01-01'),
        }],
    };
    db.messages = [];
    db.destroyed = [];

    discord.sent = [];
    discord.edits = 0;
});

describe('an alert that vanished from the live payload', () => {
    test('is looked up so the thread can be finished', async () => {
        db.messages.push(trackedMessage('inc-1'));

        provider.closed['inc-1'] = incident({
            state: 'resolved',
            endedAt: hoursAgo(1),
            updates: [makeUpdate({ id: 'u-final', state: 'resolved', body: { de: 'Behoben.' }, createdAt: hoursAgo(1) })],
        });

        await handleAlerts(7, makeClient());

        expect(provider.closedCalls).toEqual(['inc-1']);
        // The closing update lands as one more reply in the same thread.
        expect(discord.sent.some((p) => p.embeds[0].toJSON().description.includes('Behoben'))).toBe(true);
    });

    test('is not looked up while it is still live', async () => {
        // The ordinary case: nothing disappeared, so nothing is asked for. This is what keeps
        // the close-out free in steady state.
        provider.snapshot = snapshotWith([incident()]);
        db.messages.push(trackedMessage('inc-1'));

        await handleAlerts(7, makeClient());

        expect(provider.closedCalls).toEqual([]);
    });

    test('is left completely alone when the page will not confirm it', async () => {
        // `show_incident_history` off → the detail endpoint 404s → fetchClosedAlert returns
        // null. Claiming a resolution the bot cannot see would be worse than saying nothing.
        db.messages.push(trackedMessage('inc-1'));
        provider.closed['inc-1'] = null;

        await handleAlerts(7, makeClient());

        expect(provider.closedCalls).toEqual(['inc-1']);
        expect(discord.sent).toHaveLength(0);
        expect(discord.edits).toBe(0);
    });

    test('is not asked about again on the very next cycle', async () => {
        // It fails the "still live" test on EVERY cycle for as long as the reporting window
        // lasts, and the provider memo expires between cycles — so the same detail request
        // went out every 15 seconds for three days: about 17,000 per resolved incident per
        // token/locale group, and double that when the endpoint 404s and nothing is ever
        // delivered. All against the Cloud's shared edge budget.
        db.messages.push(trackedMessage('inc-1'));
        provider.closed['inc-1'] = incident({
            state: 'resolved',
            updates: [makeUpdate({ id: 'u-final', state: 'resolved', body: { de: 'Behoben.' }, createdAt: hoursAgo(1) })],
        });

        const client = makeClient();
        await handleAlerts(7, client);
        await handleAlerts(7, client);
        await handleAlerts(7, client);

        expect(provider.closedCalls).toEqual(['inc-1']);
    });

    test('is asked again once the cooldown has passed', async () => {
        // Deliberately not "settled for ever": an alert can still change after it resolves —
        // a postmortem attached after the fact — so the point is to stop hammering, not to
        // stop looking.
        db.messages.push(trackedMessage('inc-1'));
        provider.closed['inc-1'] = null;

        const client = makeClient();
        await handleAlerts(7, client);

        clearCloseoutCooldowns();
        await handleAlerts(7, client);

        expect(provider.closedCalls).toEqual(['inc-1', 'inc-1']);
    });

    test('is never touched again once it is out of the reporting window', async () => {
        // Without this bound an unconfirmable thread would be re-queried every 15 seconds,
        // for ever.
        db.messages.push(trackedMessage('inc-old', 24 * 5));

        await handleAlerts(7, makeClient());

        expect(provider.closedCalls).toEqual([]);
    });

    test('a maintenance window is closed out the same way', async () => {
        db.messages.push(trackedMessage('maint-1'));

        provider.closed['maint-1'] = makeAlert({
            id: 'maint-1',
            kind: ALERT_KIND.MAINTENANCE,
            url: 'https://status.example.com/maintenances/maint-1',
            title: { de: 'Datenbank-Upgrade' },
            body: { de: 'Wartung startet.' },
            format: BODY_FORMAT.MARKDOWN,
            state: 'completed',
            startedAt: hoursAgo(6),
            window: { start: hoursAgo(6), end: hoursAgo(1) },
            updates: [makeUpdate({ id: 'mu-final', state: 'completed', body: { de: 'Wartung abgeschlossen.' }, createdAt: hoursAgo(1) })],
        });

        await handleAlerts(7, makeClient());

        expect(discord.sent.some((p) => p.embeds[0].toJSON().description.includes('abgeschlossen'))).toBe(true);
    });

    test('a lookup failure does not fail the cycle', async () => {
        // The live part already succeeded; closing out is best effort.
        db.messages.push(trackedMessage('inc-1'));
        provider.closed['inc-1'] = Object.assign(new Error('upstream down'), { status: 503 });

        await expect(handleAlerts(7, makeClient())).resolves.toBeUndefined();
    });

    test('a subscription that opted out of NEWS is not reconciled', async () => {
        db.statuspage.Subscriptions[0].eventTypes = { STATUS: true, NEWS: false };
        db.messages.push(trackedMessage('inc-1'));

        await handleAlerts(7, makeClient());

        expect(provider.closedCalls).toEqual([]);
    });
});

describe('a channel that fails during the close-out', () => {
    /** Two subscriptions, the first of which Discord refuses. */
    const twoChannels = (failCode) => {
        db.statuspage.Subscriptions = [
            { ...db.statuspage.Subscriptions[0], id: 1, channelId: 'chan-broken' },
            { ...db.statuspage.Subscriptions[0], id: 2, channelId: 'chan-ok' },
        ];
        db.messages.push(trackedMessage('inc-1'), { ...trackedMessage('inc-1'), subscriptionId: 2 });

        provider.closed['inc-1'] = incident({
            state: 'resolved',
            updates: [makeUpdate({ id: 'u-final', state: 'resolved', body: { de: 'Behoben.' }, createdAt: hoursAgo(1) })],
        });

        return {
            channels: {
                fetch: async (id) => {
                    if (id === 'chan-broken') throw Object.assign(new Error('refused'), { code: failCode });
                    return {
                        id,
                        send: async (payload) => { discord.sent.push({ channel: id, payload }); return { id: 'm' }; },
                        messages: { edit: async () => { discord.edits += 1; return {}; } },
                    };
                },
            },
        };
    };

    test('does not cost every other guild its resolution', async () => {
        // The guard was applied to the live alert path and missed here. One guild that revoked
        // "Send Messages" aborted the whole loop, so every OTHER guild's thread stayed on "we
        // are investigating" — and never recovered, because the same error threw every cycle
        // until the three-day window closed the thread out of scope for good.
        await handleAlerts(7, twoChannels(50013));

        expect(discord.sent.map((s) => s.channel)).toEqual(['chan-ok']);
        expect(db.destroyed).toEqual([]);
    });

    test('a channel that is really gone loses its subscription, and only its own', async () => {
        await handleAlerts(7, twoChannels(10003));

        expect(db.destroyed).toEqual([1]);
        expect(discord.sent.map((s) => s.channel)).toEqual(['chan-ok']);
    });

    test('and the brake applies here too', async () => {
        // A wrong token makes EVERY channel answer 10003; this is one of the lines that would
        // otherwise delete the whole table one tidy-up at a time.
        const { resetReaper, REAP_LIMIT } = await import('../../util/subscriptionReaper.js');
        resetReaper();

        db.statuspage.Subscriptions = Array.from({ length: REAP_LIMIT + 5 }, (_, i) => ({
            ...db.statuspage.Subscriptions[0], id: i + 1, channelId: `chan-${i + 1}`,
        }));
        for (const sub of db.statuspage.Subscriptions) {
            db.messages.push({ ...trackedMessage('inc-1'), subscriptionId: sub.id });
        }
        provider.closed['inc-1'] = incident({ state: 'resolved', updates: [] });

        await handleAlerts(7, { channels: { fetch: async () => { throw Object.assign(new Error('gone'), { code: 10003 }); } } });

        expect(db.destroyed).toHaveLength(REAP_LIMIT);
        resetReaper();
    });
});

describe('throttling per subscription', () => {
    /** Three channels on one page, all tracking the same alert. */
    const threeChannels = () => {
        db.statuspage.Subscriptions = [1, 2, 3].map((id) => ({
            ...db.statuspage.Subscriptions[0], id, channelId: `chan-${id}`,
        }));
        db.messages = [1, 2, 3].map((id) => ({ ...trackedMessage('inc-1'), subscriptionId: id }));

        provider.closed['inc-1'] = incident({
            state: 'resolved',
            updates: [makeUpdate({ id: 'u-final', state: 'resolved', body: { de: 'Behoben.' }, createdAt: hoursAgo(1) })],
        });
    };

    test('every subscription receives the resolution, not just the first', async () => {
        // Keyed on the page, the first subscription's attempt silenced all the others — for
        // that cycle and every cycle after it, because whichever ran first kept refreshing the
        // cooldown. Only one channel ever saw an incident end.
        threeChannels();

        await handleAlerts(7, makeClient());

        expect(discord.sent).toHaveLength(3);
    });

    test('and it is still one lookup, not three', async () => {
        // Throttling per subscription must not undo what the cooldown was for. The provider
        // memoizes a recovered alert per (page, alert) for the length of a cycle.
        threeChannels();

        await handleAlerts(7, makeClient());

        expect(provider.closedCalls).toEqual(['inc-1', 'inc-1', 'inc-1']);
        // Three asks of the provider, which answers all of them from one request — the memo
        // lives in providers/index.js and is covered there.
    });

    test('the next cycle asks about none of them again', async () => {
        threeChannels();
        await handleAlerts(7, makeClient());
        provider.closedCalls = [];

        await handleAlerts(7, makeClient());

        expect(provider.closedCalls).toEqual([]);
    });
});

describe('the cooldown map', () => {
    test('evicts an old entry rather than growing with every alert ever seen', async () => {
        // One entry per (page, alert). Without a bound that is every alert an installation has
        // ever recovered, held for the life of the process.
        const { clearCloseoutCooldowns } = await import('../../handlers/handleAlerts.js');
        clearCloseoutCooldowns();

        // 5000 is the cap; fill past it and show the earliest is asked about again.
        db.messages.push(trackedMessage('inc-first'));
        provider.closed['inc-first'] = null;
        await handleAlerts(7, makeClient());
        expect(provider.closedCalls).toEqual(['inc-first']);

        db.messages = [];
        for (let i = 0; i < 5001; i += 1) {
            db.messages = [trackedMessage(`filler-${i}`)];
            provider.closed[`filler-${i}`] = null;
            await handleAlerts(7, makeClient());
        }

        // The first one was evicted, so it is asked about again instead of being throttled.
        provider.closedCalls = [];
        db.messages = [trackedMessage('inc-first')];
        await handleAlerts(7, makeClient());

        expect(provider.closedCalls).toEqual(['inc-first']);
    }, 60000);
});

describe('thread headlines', () => {
    // The parent already has a Message row in these fixtures, so it is EDITED; only the
    // replies are sent. That is exactly the shape of a real close-out.
    const titlesOf = () => discord.sent.map((p) => p.embeds[0].toJSON().title);

    test('a Cloud update is distinguished by its state', async () => {
        // Without this every message in a thread repeats the incident's title and a reader has
        // to open each one to find out which is the resolution.
        db.messages.push(trackedMessage('inc-1'));
        provider.closed['inc-1'] = incident({
            state: 'resolved',
            updates: [
                makeUpdate({ id: 'u-2', state: 'monitoring', body: { de: 'Fix deployed.' }, createdAt: hoursAgo(2) }),
                makeUpdate({ id: 'u-3', state: 'resolved', body: { de: 'Behoben.' }, createdAt: hoursAgo(1) }),
            ],
        });

        await handleAlerts(7, makeClient());

        expect(titlesOf()).toEqual([
            'Störung — Wird überwacht',
            'Störung — Behoben',
        ]);
    });

    test('the wording matches the statuspage own labels', async () => {
        // Taken verbatim from the Cloud's i18n, so a thread never phrases a state differently
        // from the page it reports on.
        db.messages.push(trackedMessage('maint-1'));
        provider.closed['maint-1'] = makeAlert({
            id: 'maint-1', kind: ALERT_KIND.MAINTENANCE,
            url: 'https://status.example.com/maintenances/maint-1',
            title: { de: 'Datenbank-Upgrade' }, body: { de: 'Start.' },
            format: BODY_FORMAT.MARKDOWN, state: 'completed', startedAt: hoursAgo(6),
            updates: [
                makeUpdate({ id: 'm-2', state: 'in_progress', body: { de: 'Läuft.' }, createdAt: hoursAgo(5) }),
                makeUpdate({ id: 'm-3', state: 'completed', body: { de: 'Fertig.' }, createdAt: hoursAgo(1) }),
            ],
        });

        await handleAlerts(7, makeClient());

        expect(titlesOf()).toEqual([
            'Datenbank-Upgrade — Läuft',
            'Datenbank-Upgrade — Abgeschlossen',
        ]);
    });

    test('an unknown state leaves the plain title rather than printing a key', async () => {
        db.messages.push(trackedMessage('inc-1'));
        provider.closed['inc-1'] = incident({
            updates: [makeUpdate({ id: 'u-x', state: 'brand_new_state', body: { de: 'x' }, createdAt: hoursAgo(1) })],
        });

        await handleAlerts(7, makeClient());

        expect(titlesOf().at(-1)).toBe('Störung');
    });

    test('a self-hosted update keeps its own headline', async () => {
        // It has one; the suffix exists only because a Cloud update does not.
        db.messages.push(trackedMessage('inc-1'));
        provider.closed['inc-1'] = incident({
            updates: [makeUpdate({
                id: 'u-own', title: 'Hotline Störung behoben', state: 'RESOLVED',
                body: 'Behoben.', createdAt: hoursAgo(1),
            })],
        });

        await handleAlerts(7, makeClient());

        expect(titlesOf().at(-1)).toBe('Hotline Störung behoben');
    });
});

describe('an alert that ends without a further update', () => {
    /** What a subscription sees after a cycle. */
    const seen = () => discord.sent.map((p) => p.embeds[0].toJSON().title);

    test('a cancelled maintenance is announced as cancelled', async () => {
        // The live payload only ever carries `in_progress` and `scheduled` windows, so a
        // cancelled one simply disappears — exactly like a resolved incident. The close-out
        // recovers it with `state: 'cancelled'`, and because an operator usually cancels
        // WITHOUT writing an update there is nothing to deliver as a reply. Before the parent
        // carried its state, that meant nothing happened at all: the announcement stood in the
        // channel as though the window were still coming, and the word "Abgesagt" existed in
        // the bot with no way to ever be shown.
        db.messages.push(trackedMessage('maint-1'));

        provider.closed['maint-1'] = makeAlert({
            id: 'maint-1', kind: ALERT_KIND.MAINTENANCE,
            url: 'https://status.example.com/maintenances/maint-1',
            title: { de: 'Wartung Gameserver' }, body: { de: 'Am Freitag warten wir.' },
            format: BODY_FORMAT.MARKDOWN, state: 'cancelled',
            startedAt: hoursAgo(2), window: { start: hoursAgo(2), end: null }, updates: [],
        });

        await handleAlerts(7, makeClient());

        // Edited, not posted: the announcement itself now says what happened to it.
        expect(discord.edits).toBe(1);
        expect(discord.sent).toHaveLength(0);
    });

    test('and the edit is what a reader actually sees', async () => {
        const edited = [];
        db.messages.push(trackedMessage('maint-1'));
        provider.closed['maint-1'] = makeAlert({
            id: 'maint-1', kind: ALERT_KIND.MAINTENANCE,
            url: 'https://status.example.com/maintenances/maint-1',
            title: { de: 'Wartung Gameserver' }, body: { de: 'Am Freitag warten wir.' },
            format: BODY_FORMAT.MARKDOWN, state: 'cancelled',
            startedAt: hoursAgo(2), window: { start: hoursAgo(2), end: null }, updates: [],
        });

        await handleAlerts(7, {
            channels: {
                fetch: async (id) => ({
                    id,
                    send: async () => ({ id: 'x' }),
                    messages: {
                        edit: async (_i, p) => {
                            const e = p.embeds[0].toJSON();
                            edited.push(`${e.title} | ${e.description}`);
                            return {};
                        },
                    },
                }),
            },
        });

        // The title stays plain and the state goes in the text — the Cloud's own feed builds
        // its parent item the same way, so a Discord thread and an RSS reader say the same
        // thing about the same event.
        expect(edited).toHaveLength(1);
        expect(edited[0]).toMatch(/^Wartung Gameserver \| \*\*Status:\*\* Abgesagt/);
        expect(edited[0]).toContain('Am Freitag warten wir.');
    });

    test('a resolved incident says so on the announcement too', async () => {
        // The same property, for the case that does have replies.
        const edited = [];
        db.messages.push(trackedMessage('inc-1'));
        provider.closed['inc-1'] = incident({
            state: 'resolved',
            updates: [makeUpdate({ id: 'u-final', state: 'resolved', body: { de: 'Behoben.' }, createdAt: hoursAgo(1) })],
        });

        await handleAlerts(7, {
            channels: {
                fetch: async (id) => ({
                    id,
                    send: async (p) => { discord.sent.push(p); return { id: 'r' }; },
                    messages: {
                        edit: async (_i, p) => {
                            const e = p.embeds[0].toJSON();
                            edited.push(`${e.title} | ${e.description}`);
                            return {};
                        },
                    },
                }),
            },
        });

        // Announcement: plain title, state in the text. Reply: the suffix, as the feed does it.
        expect(edited[0]).toMatch(/^Störung \| \*\*Status:\*\* Behoben/);
        expect(seen()).toEqual(['Störung — Behoben']);
    });

    test('a notice has no state and keeps its plain title', async () => {
        // A notice must never look like something that can be resolved.
        const edited = [];
        db.messages.push(trackedMessage('note-1'));
        provider.closed['note-1'] = makeAlert({
            id: 'note-1', kind: ALERT_KIND.NOTICE,
            url: 'https://status.example.com/incidents/note-1',
            title: { de: 'Hinweis zu Phishing' }, body: { de: 'Achtung.' },
            format: BODY_FORMAT.MARKDOWN, severity: null, state: null,
            startedAt: hoursAgo(2), updates: [],
        });

        await handleAlerts(7, {
            channels: {
                fetch: async (id) => ({
                    id, send: async () => ({ id: 'x' }),
                    messages: { edit: async (_i, p) => { edited.push(p.embeds[0].toJSON().title); return {}; } },
                }),
            },
        });

        for (const title of edited) expect(title).toBe('Hinweis zu Phishing');
    });

    test('an unknown state leaves the plain title rather than printing a key', async () => {
        const edited = [];
        db.messages.push(trackedMessage('maint-1'));
        provider.closed['maint-1'] = makeAlert({
            id: 'maint-1', kind: ALERT_KIND.MAINTENANCE,
            url: 'https://status.example.com/maintenances/maint-1',
            title: { de: 'Wartung' }, body: { de: 'x' }, format: BODY_FORMAT.MARKDOWN,
            state: 'brand_new_state', startedAt: hoursAgo(2), updates: [],
        });

        await handleAlerts(7, {
            channels: {
                fetch: async (id) => ({
                    id, send: async () => ({ id: 'x' }),
                    messages: { edit: async (_i, p) => { edited.push(p.embeds[0].toJSON().title); return {}; } },
                }),
            },
        });

        for (const title of edited) expect(title).toBe('Wartung');
    });
});

describe('idempotence', () => {
    test('a second cycle adds nothing', async () => {
        // The closing reply goes through the same syncMessage path as everything else, so its
        // Message row is what stops it being posted twice.
        db.messages.push(trackedMessage('inc-1'));
        provider.closed['inc-1'] = incident({
            state: 'resolved',
            updates: [makeUpdate({ id: 'u-final', state: 'resolved', body: { de: 'Behoben.' }, createdAt: hoursAgo(1) })],
        });

        const client = makeClient();
        await handleAlerts(7, client);
        const afterFirst = discord.sent.length;

        await handleAlerts(7, client);

        expect(discord.sent).toHaveLength(afterFirst);
    });
});
