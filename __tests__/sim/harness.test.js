/**
 * The simulation's own referee and oracle, checked against mistakes made on purpose.
 *
 * A simulation that never fails proves nothing: the referee could be blind to duplicates, the
 * oracle could accept any channel. Each test here commits one of the mistakes the bot must never
 * make — by hand, with a real discord.js REST client, no bot and no database — and requires the
 * harness to catch it. Runs in the ordinary `npm test`.
 */

import { REST } from 'discord.js';
import { startSimDiscord } from './harness/discord.js';
import { startSimPages } from './harness/pages.js';
import { differences } from './harness/oracle.js';
import { getLayoutRenderer } from '../../messages/layoutRenderers.js';
import { fetchSnapshot, clearSnapshotCache } from '../../providers/index.js';
import { withLocale } from '../../util/Translation.js';

let discord;
let rest;
let guild;
let channel;

beforeEach(async () => {
    discord = await startSimDiscord({ memberGraceMs: 0 });
    rest = new REST({ api: discord.api, retries: 0, timeout: 2000 }).setToken('sim');
    guild = discord.addGuild();
    channel = discord.addChannel(guild);
});

afterEach(async () => {
    await discord.close();
});

const post = (body, id = channel) => rest.post(`/channels/${id}/messages`, { body });
const rules = () => discord.violations.map((v) => v.rule);

describe('the referee', () => {
    test('sees a message posted twice', async () => {
        await post({ embeds: [{ title: 'Störung', description: 'API down' }] });
        await post({ embeds: [{ title: 'Störung', description: 'API down' }] });
        expect(rules()).toEqual(['duplicate']);
    });

    test('but not two different messages, nor a repeat Discord deduplicated by nonce', async () => {
        await post({ embeds: [{ title: 'A' }], nonce: 'n1', enforce_nonce: true });
        await post({ embeds: [{ title: 'A' }], nonce: 'n1', enforce_nonce: true });
        await post({ embeds: [{ title: 'B' }] });
        expect(rules()).toEqual([]);
        expect(discord.messagesIn(channel)).toHaveLength(2);
    });

    test('sees a reply to a message that is not there', async () => {
        await post({ embeds: [{ title: 'Update' }], message_reference: { message_id: '1234', fail_if_not_exists: false } });
        expect(rules()).toEqual(['reply-orphan']);
    });

    test('sees an edit that changes nothing', async () => {
        const message = await post({ embeds: [{ title: 'Status', description: 'grün' }] });
        await rest.patch(`/channels/${channel}/messages/${message.id}`, { body: { embeds: [{ title: 'Status', description: 'grün' }] } });
        expect(rules()).toEqual(['noop-edit']);
    });

    test('but not the same edit sent again after its answer was lost', async () => {
        const message = await post({ embeds: [{ title: 'Status', description: 'grün' }] });
        discord.fault(channel, 'badGateway');
        await rest.patch(`/channels/${channel}/messages/${message.id}`, { body: { embeds: [{ title: 'Status', description: 'rot' }] } }).catch(() => {});
        discord.fault(channel, 'none');
        await rest.patch(`/channels/${channel}/messages/${message.id}`, { body: { embeds: [{ title: 'Status', description: 'rot' }] } });
        expect(rules()).toEqual([]);
    });

    const identify = async () => {
        const ws = new WebSocket(discord.gatewayUrl);
        await new Promise((resolve) => ws.addEventListener('open', resolve));
        ws.send(JSON.stringify({ op: 2, d: {} }));
        await new Promise((resolve) => setTimeout(resolve, 100));
        return ws;
    };

    test('sees a bot that keeps asking a guild it was kicked from', async () => {
        discord.resetReady();
        const ws = await identify();
        discord.kick(guild);
        await new Promise((resolve) => setTimeout(resolve, 20));
        // One or two that discord.js already had queued are stragglers, not the bot asking again.
        await post({ content: '1' }).catch(() => {});
        expect(rules()).toEqual([]);
        for (let i = 0; i < 6; i += 1) await post({ content: String(i) }).catch(() => {});
        ws.close();
        expect(rules()).toContain('not-a-member');
    });

    test('sees even one request to a guild the bot knew at login it was not in', async () => {
        discord.resetReady();
        discord.removeQuietly(guild);
        const ws = await identify();
        await new Promise((resolve) => setTimeout(resolve, 20));
        await post({ content: 'hallo' }).catch(() => {});
        ws.close();
        expect(rules()).toEqual(['not-a-member']);
    });

    test('rejects and reports a message over Discord\'s limits', async () => {
        await expect(post({ embeds: [{ title: 'x'.repeat(300) }] })).rejects.toMatchObject({ status: 400 });
        expect(rules()).toEqual(['limits']);
    });

    test('sees a route the bot was never meant to call', async () => {
        await rest.get('/users/@me/guilds').catch(() => {});
        expect(rules()).toEqual(['unknown-route']);
    });

    test('answers like Discord when the bot overruns its global limit, and calls it out when it keeps doing it', async () => {
        const raw = (i) => fetch(`${discord.api}/v10/channels/${channel}`, { headers: { authorization: `Bot ${i}` } });
        const answers = await Promise.all(Array.from({ length: 60 }, (_, i) => raw(i)));
        expect(answers.filter((a) => a.status === 429)).toHaveLength(10);
        expect(rules()).toContain('burst');
    });

    test('a hidden, read-only or deleted channel answers with Discord\'s codes', async () => {
        const codes = [];
        for (const access of ['hidden', 'readonly', 'deleted']) {
            discord.setAccessQuietly(channel, access);
            codes.push(await post({ content: access }).catch((e) => e.code));
        }
        expect(codes).toEqual([50001, 50013, 10003]);
    });
});

describe('the oracle', () => {
    let pages;
    let slug;
    let sub;

    beforeEach(async () => {
        pages = await startSimPages();
        slug = pages.addPage({ name: 'Orakel' });
        sub = { id: 1, channelId: channel, locale: 'de', layout: 'DETAILED', eventTypes: { STATUS: true, NEWS: true }, createdAt: new Date(Date.now() - 3600_000), url: pages.url(slug), name: 'Orakel', kind: null, externalId: null };
        clearSnapshotCache();
    });

    afterEach(async () => { await pages.close(); });

    /** What a correct bot would have posted for the page as it is now. */
    const postCorrectly = async () => {
        const snapshot = await fetchSnapshot({ url: sub.url, name: sub.name }, { locale: 'de' });
        const embeds = withLocale('de', () => getLayoutRenderer('DETAILED')(snapshot, 'de').map((r) => r.embed.toJSON()));
        return post({ embeds });
    };
    const check = () => differences({ discord, pages, subscriptions: [sub] });

    test('accepts a channel that is exactly right', async () => {
        await postCorrectly();
        expect(await check()).toEqual([]);
    });

    test('sees a missing status message, and a stale one', async () => {
        expect(await check()).toEqual([expect.stringMatching(/no status message/)]);
        await postCorrectly();
        pages.setService(slug, 0, 'major_outage');
        clearSnapshotCache();
        expect((await check()).join()).toMatch(/stale/);
    });

    test('sees a missing announcement, a missing reply, a reply out of place and a message too many', async () => {
        await postCorrectly();
        const incident = pages.openIncident(slug);
        await fetch(`${pages.url(slug)}/api/statuspage/${pages.page(slug).pageId}/full`); // the bot "saw" it
        expect((await check()).join()).toMatch(/0 announcements/);

        const [first] = pages.incidents(slug)[0].updates;
        const parent = await post({ embeds: [{ title: pages.incidents(slug)[0].title.de, description: first.message.de }] });
        pages.updateIncident(slug, incident);
        expect((await check()).join()).toMatch(/0 replies, expected 1/);

        await post({ embeds: [{ title: `${pages.incidents(slug)[0].title.de} — x`, description: 'falscher Text' }], message_reference: { message_id: parent.id } });
        expect((await check()).join()).toMatch(/should say/);

        await post({ embeds: [{ title: 'Irgendwas' }] });
        expect((await check()).join()).toMatch(/unexpected message/);
    });

    test('sees anything left of an incident that was taken off the page', async () => {
        pages.openIncident(slug);
        await postCorrectly(); // the status embed shows the incident too
        const incident = pages.incidents(slug)[0];
        await post({ embeds: [{ title: incident.title.de, description: incident.updates[0].message.de }] });
        expect(await check()).toEqual([]);

        pages.removeIncident(slug, incident.id);
        expect((await check()).join()).toMatch(/taken off the page/);
    });
});
