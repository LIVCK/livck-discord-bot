/**
 * Discord misbehaving, and the bot being stopped in the middle of things.
 *
 * Every fault discord.js meets in production, on some channels at once, while an incident is
 * running: requests that hang, answers that never arrive, 502s after the work was done, 500s,
 * dropped connections, 429s. The channels without a fault must not notice; once it heals, every
 * channel must end up exactly right, with not one message twice.
 *
 * Then the process itself: SIGTERM mid-burst (a deploy), SIGKILL mid-burst (the host died), and
 * the gateway dropping the connection.
 */

import { jest } from '@jest/globals';
import { createWorld, enabled } from './harness/world.js';

const maybe = enabled ? describe : describe.skip;
jest.setTimeout(300_000);

const FAULTS = ['hang', 'loseAnswer', 'badGateway', 'serverError', 'reset', 'rateLimited', { delayMs: 2500 }];

const waitUntil = async (condition, timeout = 20_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('condition not reached');
};

maybe('Discord misbehaving', () => {
    let world;
    afterEach(async () => { await world?.close(); });

    /** One page, `count` guilds with one channel each, every layout. */
    const fleet = async (count, options = {}) => {
        world = await createWorld(options);
        const page = world.page({ name: 'Plattform', groups: 3, services: 9 });
        const channels = [];
        const layouts = ['DETAILED', 'COMPACT', 'OVERVIEW', 'MINIMAL', 'TREE'];
        for (let i = 0; i < count; i += 1) {
            const guild = world.guild();
            const channel = world.channel(guild);
            channels.push(channel);
            await world.subscribe({ guild, channel, page, layout: layouts[i % layouts.length], locale: i % 2 ? 'en' : 'de' });
        }
        return { page, channels };
    };

    test('every kind of fault at once: the healthy channels are on time, and after it heals nothing is missing or doubled', async () => {
        const { page, channels } = await fleet(FAULTS.length + 3);
        const bot = await world.start();
        await world.converge();

        const faulty = channels.slice(0, FAULTS.length);
        const healthy = channels.slice(FAULTS.length);
        faulty.forEach((channel, i) => world.discord.fault(channel, FAULTS[i]));

        const incident = world.pages.openIncident(page, { severity: 'critical' });
        world.pages.setService(page, 0, 'major_outage');
        const tookMs = await world.converge({ channels: healthy, timeout: 15_000 });
        // A cycle is one second here; a hanging channel must not cost the others more than a few.
        expect(tookMs).toBeLessThan(6000);

        for (let i = 0; i < 3; i += 1) {
            world.pages.updateIncident(page, incident);
            await world.converge({ channels: healthy, timeout: 15_000 });
        }

        world.discord.heal();
        await world.converge({ timeout: 60_000 });
        await world.quiet(bot);
        world.clean();
        // The 429s are the rate-limited channel's own; a ladder, not a hammer.
        expect(world.discord.invalidRequestPeak()).toBeLessThan(40);
    });

    test('a deploy in the middle of a burst: the next process posts what is missing and nothing twice', async () => {
        const { page, channels } = await fleet(20);
        const bot = await world.start();
        await world.converge();

        const incident = world.pages.openIncident(page);
        for (let i = 0; i < 4; i += 1) world.pages.updateIncident(page, incident);
        world.pages.setService(page, 3, 'partial_outage');

        // Stopped while the burst is going out.
        const before = world.discord.log.filter((e) => e.method === 'POST').length;
        await waitUntil(() => world.discord.log.filter((e) => e.method === 'POST').length >= before + 15);
        const exit = await bot.stop();
        expect(exit).toEqual({ code: 0, signal: null });

        const next = await world.start();
        await world.converge({ timeout: 60_000 });
        await world.quiet(next);
        world.clean();
        expect(channels.length).toBe(20);
    });

    test('the host dies between Discord making a message and the bot writing it down', async () => {
        // SIGKILL at the worst possible moment, deterministically: the referee lets the
        // fifteenth new message of the burst be made, kills the bot before the answer leaves,
        // and only then answers. That message is in the channel and in no database.
        const { page } = await fleet(20);
        const bot = await world.start();
        await world.converge();

        const start = world.discord.messages.size;
        let killed = false;
        world.discord.beforeAnswer(async ({ count }) => {
            if (killed || count < start + 15) return;
            killed = true;
            await bot.kill();
        });

        const incident = world.pages.openIncident(page);
        for (let i = 0; i < 4; i += 1) world.pages.updateIncident(page, incident);
        await bot.exited;
        expect(killed).toBe(true);
        world.discord.beforeAnswer(null);

        const next = await world.start();
        await world.converge({ timeout: 60_000 });
        await world.quiet(next);
        world.clean();
    });

    test('the gateway drops the connection: the bot comes back by itself and misses nothing', async () => {
        const { page } = await fleet(4);
        const bot = await world.start();
        await world.converge();

        world.discord.disconnectGateway(4000);
        const incident = world.pages.openIncident(page);
        await bot.waitFor(/./, { timeout: 5000 });
        await waitUntil(() => world.discord.isConnected(), 30_000);

        world.pages.updateIncident(page, incident);
        world.pages.setService(page, 5, 'degraded');
        await world.converge();
        await world.quiet(bot);
        world.clean();
        expect(bot.exit).toBeNull();
    });
});
