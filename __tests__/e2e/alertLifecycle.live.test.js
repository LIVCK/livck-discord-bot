/**
 * An incident's whole life, replayed against real Discord.
 *
 * Everything else about alerts has been checked at one instant: a historical alert rendered,
 * a close-out driven with a stubbed provider. What was never checked is the PROGRESSION — the
 * parent posted, an update arriving as a reply under it, another, the resolution, and then the
 * alert leaving the live payload. That is the sequence a customer actually watches, and every
 * part of it depends on state written by the cycle before.
 *
 * So a real incident is replayed one update at a time. `0coRsn8ll1vrJSo2yAF3T` on
 * status.emeraldhost.de went identified → monitoring → resolved over about an hour in August.
 * Its content and structure are used exactly as the API returns them; only the timestamps are
 * moved into the present, because the bot ignores anything older than its three-day reporting
 * window and there is no other way to watch an old incident happen again.
 *
 *   LIVCK_DISCORD_E2E=1 DB_HOST=127.0.0.1 DB_DATABASE=livck_bot_discord DB_USERNAME=root \
 *     DB_PASSWORD= REDIS_HOST=127.0.0.1 REDIS_PORT=6379 REDIS_PASSWORD= \
 *     npm test -- __tests__/e2e/alertLifecycle.live.test.js --runInBand
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { jest } from '@jest/globals';

dotenv.config();

const enabled = process.env.LIVCK_DISCORD_E2E === '1';

const readCredentials = () => {
    const file = path.resolve('.env.test');
    if (!fs.existsSync(file)) return {};
    return Object.fromEntries(
        fs.readFileSync(file, 'utf8').split('\n')
            .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
            .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
    );
};

const credentials = enabled ? { ...process.env, ...readCredentials() } : {};
const ready = enabled && credentials.DISCORD_BOT_TOKEN && credentials.TEST_GUILD_ID && credentials.TEST_CHANNEL_ID;

/** What the fake provider hands back this cycle. */
const provider = { snapshot: null, closed: {} };

if (enabled) {
    jest.unstable_mockModule('../../providers/index.js', () => ({
        fetchSnapshot: async () => provider.snapshot,
        fetchClosedAlert: async (_page, id) => {
            const value = provider.closed[id];
            // A fixture is either the recovered alert or an explicit verdict — the shape the
            // real provider returns, so "removed" is exercised here rather than assumed.
            if (value && typeof value === 'object' && 'removed' in value) return value;
            return { alert: value ?? null, removed: false };
        },
        resolveSource: async () => 'CLOUD',
        clearSnapshotCache: () => {},
        NotLivckError: class NotLivckError extends Error {},
        default: {},
    }));
}

const e2e = ready ? describe : describe.skip;

e2e('an incident from first report to resolution', () => {
    let client;
    let models;
    let channel;
    let handleAlerts;
    let clearCloseoutCooldowns;

    let page;
    let subscription;
    let source;

    const posted = [];

    /** Straight from the API, never from discord.js's cache. */
    const fetchFresh = (id) => channel.messages.fetch({ message: id, force: true });

    beforeAll(async () => {
        models = (await import('../../models/index.js')).default;

        const { host, database } = models.database.config;
        if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error(`Refusing host "${host}".`);
        if (!/test|e2e|discord|throwaway/i.test(database || '')) throw new Error(`Refusing database "${database}".`);

        ({ handleAlerts, clearCloseoutCooldowns } = await import('../../handlers/handleAlerts.js'));

        const { Client, GatewayIntentBits } = await import('discord.js');
        client = new Client({ intents: [GatewayIntentBits.Guilds] });
        await client.login(credentials.DISCORD_BOT_TOKEN);
        channel = await client.channels.fetch(credentials.TEST_CHANNEL_ID);

        // The real thing, fetched through the real adapter.
        const { fetchClosedAlert } = await import('../../providers/cloud.js');
        ({ alert: source } = await fetchClosedAlert(
            { url: 'https://status.emeraldhost.de', name: 'eh', externalId: 'jzrYG3ZN7ldnMmMKn6725' },
            '0coRsn8ll1vrJSo2yAF3T'
        ));
        if (!source || source.updates.length < 3) {
            throw new Error('The reference incident changed shape; pick another from /history.');
        }

        await models.Message.destroy({ where: {}, truncate: true, cascade: true });
        await models.Subscription.destroy({ where: {} });
        await models.Statuspage.destroy({ where: {} });

        page = await models.Statuspage.create({
            url: 'https://lifecycle.example', name: 'lifecycle', kind: 'CLOUD', externalId: 'x',
        });
        subscription = await models.Subscription.create({
            guildId: credentials.TEST_GUILD_ID,
            channelId: credentials.TEST_CHANNEL_ID,
            statuspageId: page.id,
            layout: 'DETAILED',
            locale: 'de',
            eventTypes: { STATUS: false, NEWS: true },
            interval: 60,
            createdAt: new Date('2020-01-01'),
        });
    }, 180000);

    afterAll(async () => {
        for (const id of posted) await channel?.messages?.delete(id).catch(() => {});
        if (models) await models.database.close();
        if (client) await client.destroy();
        const cache = (await import('../../database/redis.js')).default;
        if (cache?.isOpen) await cache.quit();
    }, 120000);

    /**
     * The incident as it looked after `count` updates, dated into the present.
     *
     * Relative spacing is preserved — the real one ran about an hour — so the thread's
     * timestamps read the way the original did.
     */
    const atStage = (count) => {
        const started = Date.now() - 2 * 60 * 60 * 1000;
        const origin = new Date(source.startedAt).getTime();
        const shift = (iso) => new Date(started + (new Date(iso).getTime() - origin)).toISOString();

        return {
            ...source,
            startedAt: shift(source.startedAt),
            endedAt: null,
            state: count === 0 ? 'identified' : source.updates[count - 1].state,
            updates: source.updates.slice(0, count).map((u) => ({ ...u, createdAt: shift(u.createdAt) })),
        };
    };

    const snapshotWith = (alerts) => ({
        source: 'CLOUD',
        url: 'https://lifecycle.example',
        name: { de: 'Lifecycle' },
        overall: 'major_outage',
        defaultLocale: 'de',
        locales: ['de'],
        groups: [],
        alerts,
    });

    /** One cycle. */
    const cycle = async (alerts) => {
        clearCloseoutCooldowns();
        provider.snapshot = snapshotWith(alerts);
        await handleAlerts(page.id, client);

        for (const row of await models.Message.findAll()) {
            if (!posted.includes(row.messageId)) posted.push(row.messageId);
        }
    };

    const rows = () => models.Message.findAll({
        where: { subscriptionId: subscription.id },
        order: [['id', 'ASC']],
    });

    test('the first report is posted as the parent', async () => {
        await cycle([atStage(0)]);

        const all = await rows();
        expect(all).toHaveLength(1);
        expect(all[0].category).toBe('NEWS');
        expect(all[0].kind).toBe('incident');

        const message = await fetchFresh(all[0].messageId);
        // Plain title, state in the text — the Cloud's own feed builds its parent item the
        // same way, and the suffix belongs to the updates below.
        expect(message.embeds[0].title).toBe('Störung er1.cgn1.as200482.net');
        expect(message.embeds[0].description).toContain('Status:');
        expect(message.reference).toBeNull(); // it is the parent
    }, 180000);

    test('nothing happens again while nothing has changed', async () => {
        const before = (await fetchFresh((await rows())[0].messageId)).editedTimestamp;

        await cycle([atStage(0)]);

        expect(await rows()).toHaveLength(1);
        expect((await fetchFresh((await rows())[0].messageId)).editedTimestamp).toBe(before);
    }, 180000);

    test('the first update arrives as a reply under it', async () => {
        await cycle([atStage(1)]);

        const all = await rows();
        expect(all).toHaveLength(2);
        expect(all[1].category).toBe('ALERT');

        const parentId = all[0].messageId;
        const reply = await fetchFresh(all[1].messageId);

        expect(reply.reference?.messageId).toBe(parentId);
        expect(reply.embeds[0].title).toBe('Störung er1.cgn1.as200482.net — Identifiziert');
        expect(reply.embeds[0].description).toContain('identifiziert');
    }, 180000);

    test('the second lands under the same parent, not under the first reply', async () => {
        await cycle([atStage(2)]);

        const all = await rows();
        expect(all).toHaveLength(3);

        const reply = await fetchFresh(all[2].messageId);
        expect(reply.reference?.messageId).toBe(all[0].messageId);
        expect(reply.embeds[0].title).toBe('Störung er1.cgn1.as200482.net — Wird überwacht');
    }, 180000);

    test('the resolution is the last reply, and says so', async () => {
        await cycle([atStage(3)]);

        const all = await rows();
        expect(all).toHaveLength(4);

        const reply = await fetchFresh(all[3].messageId);
        expect(reply.embeds[0].title).toBe('Störung er1.cgn1.as200482.net — Behoben');
        expect(reply.embeds[0].description).toContain('behoben');
    }, 180000);

    test('the announcement has followed the incident all the way to resolved', async () => {
        // It began at "Identifiziert" and each transition edited its text — one edit per
        // change and none in between, because the content hash moves exactly when the state
        // does. An alert that ends without a further update ends visibly for the same reason.
        const all = await rows();
        const parent = await fetchFresh(all[0].messageId);

        expect(parent.embeds[0].title).toBe('Störung er1.cgn1.as200482.net');
        expect(parent.embeds[0].description).toContain('Behoben');
    }, 180000);

    test('the thread reads in the order it happened', async () => {
        const all = await rows();
        const messages = await Promise.all(all.map((row) => fetchFresh(row.messageId)));
        const stamps = messages.map((m) => m.embeds[0].timestamp).map((t) => new Date(t).getTime());

        expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
    }, 180000);

    test('and when the incident leaves the payload, nothing is repeated', async () => {
        // The close-out exists for an ending the bot has NOT already delivered. This one it
        // has, so recovering the same resolution must not post it a second time.
        provider.closed[source.id] = { ...atStage(3), state: 'resolved', endedAt: new Date().toISOString() };

        await cycle([]);

        expect(await rows()).toHaveLength(4);
    }, 180000);

    test('a resolution the bot never saw IS delivered when the alert vanishes', async () => {
        // The case the close-out was built for: the Cloud drops a resolved incident from the
        // live payload between two cycles, so the last thing the thread ever showed would
        // otherwise be "we are investigating".
        await models.Message.destroy({ where: { subscriptionId: subscription.id, category: 'ALERT' } });
        const beforeRows = await rows();
        expect(beforeRows).toHaveLength(1);

        provider.closed[source.id] = { ...atStage(3), state: 'resolved', endedAt: new Date().toISOString() };
        await cycle([]);

        const after = await rows();
        expect(after.length).toBeGreaterThan(1);

        const last = await fetchFresh(after.at(-1).messageId);
        expect(last.reference?.messageId).toBe(beforeRows[0].messageId);
        expect(last.embeds[0].title).toContain('Behoben');
    }, 180000);

    test('and when the incident is taken OFF the page, the thread goes with it', async () => {
        // The other ending, and the only irreversible one. A resolved incident stays and gets
        // its closing reply — that is every test above. An incident the operator REMOVED gets
        // no announcement anywhere: the status page tells nobody, because the usual reason is
        // that it should not have been published, so the bot removes what it posted instead
        // of narrating a retraction the page itself does not make.
        //
        // Everything here is real: real messages in a real channel, deleted through the real
        // API by the production path, with the bot holding only View Channels, Send Messages,
        // Embed Links and Read Message History.
        const before = await rows();
        expect(before.length).toBeGreaterThan(1);

        provider.closed[source.id] = { alert: null, removed: true };
        clearCloseoutCooldowns();
        await cycle([]);

        // Not one row left, and not one message left in the channel.
        expect(await rows()).toHaveLength(0);
        for (const row of before) {
            await expect(fetchFresh(row.messageId)).rejects.toMatchObject({ code: 10008 });
        }
    }, 180000);
});
