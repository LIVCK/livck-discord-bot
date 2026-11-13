/**
 * /livck subscribe the way an admin does it: the slash command arrives over the gateway, the bot
 * answers with its modal, the admin fills it in and sends it, the bot detects the page, writes
 * the subscription and posts the first status message — all through discord.js's own parsing of
 * what Discord sends, which is exactly what the modal patch used to rewrite and what a discord.js
 * upgrade can break without a single unit test noticing.
 */

import { jest } from '@jest/globals';
import { createWorld, enabled } from './harness/world.js';
import { BOT_ID, adminRole } from './harness/discord.js';

const maybe = enabled ? describe : describe.skip;
jest.setTimeout(180_000);

const ADMIN = '8';
const NOBODY = '0';

const waitFor = async (read, what, timeout = 15_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = read();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`no ${what} within ${timeout}ms`);
};

maybe('/livck subscribe, end to end', () => {
    let world;
    afterEach(async () => { await world?.close(); });

    const member = (permissions, guild) => ({
        user: { id: '1100000000000000077', username: 'admin', discriminator: '0', global_name: 'Admin', avatar: null },
        roles: permissions === ADMIN ? [adminRole(guild)] : [],
        joined_at: new Date().toISOString(), deaf: false, mute: false, flags: 0, permissions,
    });

    /** The slash command, as Discord dispatches it. */
    const command = (guild, channel, permissions = ADMIN) => {
        const livck = world.discord.commands().find((c) => c.name === 'livck');
        return world.discord.interact({
            type: 2,
            data: { id: livck.id, name: 'livck', type: 1, options: [{ type: 1, name: 'subscribe', options: [] }] },
            guild_id: guild, channel_id: channel,
            channel: { id: channel, type: 0, guild_id: guild, name: 'status', permissions: '2248473465835073' },
            member: member(permissions, guild), locale: 'de', guild_locale: 'de',
            app_permissions: '2248473465835073', entitlements: [], authorizing_integration_owners: { 0: guild }, context: 0,
        });
    };

    /** The modal, filled in and sent, as Discord dispatches it — Label components and all. */
    const submit = (guild, channel, { url, events = 'all', locale = 'en', layout = 'COMPACT' }, permissions = ADMIN) => world.discord.interact({
        type: 5,
        data: {
            custom_id: 'subscribe_complete_modal',
            components: [
                { type: 18, id: 1, component: { type: 4, id: 2, custom_id: 'url', value: url } },
                { type: 18, id: 3, component: { type: 8, id: 4, custom_id: 'channel', values: [channel] } },
                { type: 18, id: 5, component: { type: 3, id: 6, custom_id: 'events', values: [events] } },
                { type: 18, id: 7, component: { type: 3, id: 8, custom_id: 'locale', values: [locale] } },
                { type: 18, id: 9, component: { type: 3, id: 10, custom_id: 'layout', values: [layout] } },
            ],
            resolved: { channels: { [channel]: { id: channel, type: 0, name: 'status', permissions: '2248473465835073' } } },
        },
        guild_id: guild, channel_id: channel,
        channel: { id: channel, type: 0, guild_id: guild, name: 'status', permissions: '2248473465835073' },
        member: member(permissions, guild), locale: 'de', guild_locale: 'de',
        app_permissions: '2248473465835073', entitlements: [], authorizing_integration_owners: { 0: guild }, context: 0,
    });

    test('command, modal, submit: the subscription exists, the status message is posted, incidents follow', async () => {
        world = await createWorld();
        const guild = world.guild();
        const channel = world.channel(guild);
        const page = await world.rootPage({ name: 'Kundenseite', groups: 2, services: 5 });
        const bot = await world.start();

        const asked = command(guild, channel);
        const [modal] = await waitFor(() => asked.answers().length && asked.answers(), 'modal');
        expect(modal.type).toBe(9);
        expect(modal.data.custom_id).toBe('subscribe_complete_modal');
        expect(modal.data.components.map((c) => c.component.custom_id)).toEqual(['url', 'channel', 'events', 'locale', 'layout']);

        const sent = submit(guild, channel, { url: page.url, locale: 'en', layout: 'COMPACT' });
        const [deferred] = await waitFor(() => sent.answers().length && sent.answers(), 'deferred reply');
        expect(deferred.type).toBe(5);
        const reply = await waitFor(() => sent.followups().find((f) => f.method === 'PATCH'), 'confirmation');
        expect(reply.body.content).toContain(page.url);

        const [subscription] = await world.subscriptions();
        expect(subscription).toMatchObject({ guildId: guild, channelId: channel, locale: 'en', layout: 'COMPACT', url: page.url, kind: 'CLOUD' });

        await world.converge();
        const incident = page.pages.openIncident(page.slug);
        page.pages.setService(page.slug, 1, 'major_outage');
        await world.converge();
        page.pages.updateIncident(page.slug, incident);
        await world.converge();
        await world.quiet(bot);
        world.clean();
        expect(world.discord.messagesIn(channel).every((m) => m.author.id === BOT_ID)).toBe(true);
    });

    test('the same subscription twice is refused, not doubled', async () => {
        world = await createWorld();
        const guild = world.guild();
        const channel = world.channel(guild);
        const page = await world.rootPage({ name: 'Kundenseite' });
        await world.start();

        const first = submit(guild, channel, { url: page.url });
        await waitFor(() => first.followups().find((f) => f.method === 'PATCH'), 'confirmation');
        const second = submit(guild, channel, { url: page.url });
        const [answer] = await waitFor(() => second.answers().length && second.answers(), 'answer');

        expect(answer.data.content).toMatch(/already|bereits/i);
        expect(await world.subscriptions()).toHaveLength(1);
        await world.converge();
        world.clean();
    });

    test('someone without Manage Server gets a refusal and changes nothing', async () => {
        world = await createWorld();
        const guild = world.guild();
        const channel = world.channel(guild);
        const page = await world.rootPage({ name: 'Kundenseite' });
        await world.start();

        const asked = command(guild, channel, NOBODY);
        const [refusal] = await waitFor(() => asked.answers().length && asked.answers(), 'refusal');
        expect(refusal.type).toBe(4);
        expect(refusal.data.flags & 64).toBe(64);

        const sneaky = submit(guild, channel, { url: page.url }, NOBODY);
        await waitFor(() => sneaky.answers().length, 'refusal');
        expect(await world.subscriptions()).toHaveLength(0);
        expect(world.discord.messagesIn(channel)).toHaveLength(0);
        world.clean();
    });

    test('a URL that is not a LIVCK page is turned down with a reason', async () => {
        world = await createWorld();
        const guild = world.guild();
        const channel = world.channel(guild);
        await world.start();

        const sent = submit(guild, channel, { url: `${world.discord.api.replace('/api', '')}` });
        const reply = await waitFor(() => sent.followups().find((f) => f.method === 'PATCH'), 'reply');
        expect(reply.body.content).toBeTruthy();
        expect(await world.subscriptions()).toHaveLength(0);
        world.clean({ allow: ['unknown-route'] });
    });
});
