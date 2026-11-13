/**
 * Guilds and channels the bot loses and gets back, the way Discord actually reports it.
 *
 * What matters here is irreversible in one direction — a deleted subscription is a customer's
 * setup gone — and expensive in the other: every request to a channel the bot cannot reach is
 * an invalid request, and Discord bans an IP for ten thousand of them in ten minutes. So each
 * case checks both: what happened to the subscription, and how often the bot asked.
 */

import { jest } from '@jest/globals';
import { createWorld, enabled } from './harness/world.js';

const maybe = enabled ? describe : describe.skip;
jest.setTimeout(240_000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

maybe('guilds and channels the bot loses', () => {
    let world;
    afterEach(async () => { await world?.close(); });

    /** Two guilds, one page, one channel each; the bot running and every channel right. */
    const twoGuilds = async () => {
        world = await createWorld();
        const page = world.page({ name: 'Plattform' });
        const kept = world.guild({ name: 'kept' });
        const lost = world.guild({ name: 'lost' });
        const keptChannel = world.channel(kept);
        const lostChannel = world.channel(lost);
        const keptSub = await world.subscribe({ guild: kept, channel: keptChannel, page });
        const lostSub = await world.subscribe({ guild: lost, channel: lostChannel, page });
        const bot = await world.start();
        await world.converge();
        return { page, kept, lost, keptChannel, lostChannel, keptSub, lostSub, bot };
    };

    const subscriptionIds = async () => (await world.subscriptions()).map((s) => s.id).sort();

    test('kicked while running: the guild\'s subscriptions go at once, and the bot never asks it again', async () => {
        const { page, lost, lostChannel, keptSub, bot } = await twoGuilds();

        world.discord.kick(lost);
        await bot.cycles(2);
        expect(await subscriptionIds()).toEqual([keptSub]);

        // Life goes on in the guild that kept the bot, and none of it reaches the other.
        const incident = world.pages.openIncident(page);
        world.pages.setService(page, 0, 'major_outage');
        await world.converge();
        world.pages.updateIncident(page, incident);
        await world.converge();

        expect(world.discord.requestsSince(world.discord.guild(lost).leftAt + 3000, (e) => e.channelId === lostChannel)).toEqual([]);
        world.clean();
    });

    test('kicked while it was down: skipped without a single request, kept, and back on its own when invited again', async () => {
        const { page, lost, lostChannel, bot } = await twoGuilds();
        const before = await subscriptionIds();

        await bot.stop();
        world.discord.removeQuietly(lost);
        world.discord.resetReady();
        world.pages.setService(page, 1, 'partial_outage');
        world.pages.openIncident(page);

        const again = await world.start();
        await again.waitFor(/1 subscription\(s\) in 1 guild\(s\) the bot is not in/);
        await world.converge();
        await again.cycles(3);

        // Not deleted: a bot with the wrong token sees every guild missing, and must not delete.
        expect(await subscriptionIds()).toEqual(before);
        expect(world.discord.requestsSince(world.discord.readyAt(), (e) => e.channelId === lostChannel)).toEqual([]);

        // Invited back: it catches up with everything it missed, as if nothing had happened.
        world.discord.invite(lost);
        await world.converge();
        await world.quiet(again);
        world.clean();
    });

    test('a guild Discord reports unavailable is an outage, not a kick', async () => {
        const { lost, bot } = await twoGuilds();
        const before = await subscriptionIds();

        const back = world.discord.outage(lost);
        await bot.cycles(3);
        expect(await subscriptionIds()).toEqual(before);
        back();
        await world.converge();
        world.clean();
    });

    test('a channel the bot cannot see is kept, asked rarely, and back the moment its permission is', async () => {
        const { page, lostChannel, bot } = await twoGuilds();
        const before = await subscriptionIds();

        // Made private with nothing the bot hears about — a role edit elsewhere.
        world.discord.setAccessQuietly(lostChannel, 'hidden');
        world.pages.setService(page, 2, 'major_outage');
        const hiddenSince = Date.now();
        await sleep(9000);
        await bot.cycles(1);

        expect(await subscriptionIds()).toEqual(before);
        // Nine seconds of one-second cycles; the backoff ladder for 50001 is 1s, 5s, 15s … here.
        const asked = world.discord.requestsSince(hiddenSince, (e) => e.channelId === lostChannel);
        expect(asked.length).toBeLessThanOrEqual(3);

        // The admin gives the access back. The CHANNEL_UPDATE clears the backoff, so it does not
        // wait out the fifteen seconds it had reached.
        world.discord.setAccess(lostChannel, 'ok');
        await world.converge({ timeout: 5000 });
        world.clean();
    });

    test('a channel the bot may see but not post in is kept and recovers', async () => {
        const { page, lostChannel } = await twoGuilds();
        const before = await subscriptionIds();

        world.discord.setAccessQuietly(lostChannel, 'readonly');
        world.pages.setService(page, 0, 'degraded');
        await sleep(5000);
        expect(await subscriptionIds()).toEqual(before);

        world.discord.setAccess(lostChannel, 'ok');
        await world.converge({ timeout: 8000 });
        world.clean();
    });

    test('a deleted channel takes its subscription with it, and is not asked again', async () => {
        const { page, lostChannel, keptSub, bot } = await twoGuilds();

        world.discord.setAccess(lostChannel, 'deleted');
        world.pages.setService(page, 0, 'major_outage');
        await bot.cycles(3);
        expect(await subscriptionIds()).toEqual([keptSub]);

        const since = Date.now();
        world.pages.openIncident(page);
        await world.converge();
        await bot.cycles(2);
        expect(world.discord.requestsSince(since, (e) => e.channelId === lostChannel)).toEqual([]);
        world.clean();
    });
});
