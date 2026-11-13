/**
 * A day in production, compressed: several guilds and pages, every layout and both languages,
 * incidents that open, develop, get corrected, resolve or are taken down — and after every step
 * the channels must be exactly what the world says, the bot must fall silent once they are, and
 * the referee must not have seen a single broken rule.
 *
 * The real bot process against a simulated Discord and simulated status pages: see
 * __tests__/sim/README.md.
 */

import { jest } from '@jest/globals';
import { createWorld, enabled } from './harness/world.js';

const maybe = enabled ? describe : describe.skip;
jest.setTimeout(240_000);

maybe('a day in production', () => {
    let world;
    afterEach(async () => { await world?.close(); });

    test('incidents from first post to resolution, in every layout and language', async () => {
        world = await createWorld();
        const { pages } = world;

        const shop = world.page({ name: 'Shop', groups: 3, services: 9 });
        const api = world.page({ name: 'API Platform', groups: 2, services: 6 });
        const hidden = world.page({ name: 'Intern', groups: 1, services: 3, showHistory: false });

        const layouts = ['DETAILED', 'COMPACT', 'OVERVIEW', 'MINIMAL', 'TREE'];
        let n = 0;
        for (const guildName of ['alpha', 'beta', 'gamma']) {
            const guild = world.guild({ name: guildName });
            for (const page of [shop, api, hidden]) {
                const channel = world.channel(guild);
                await world.subscribe({
                    guild, channel, page,
                    layout: layouts[n % layouts.length],
                    locale: n % 2 === 0 ? 'de' : 'en',
                    news: n % 4 !== 3,
                });
                n += 1;
            }
        }

        const bot = await world.start();

        // First contact: one status message per subscription, nothing else.
        await world.converge();
        await world.quiet(bot);

        // An outage on two pages at once.
        pages.setService(shop, 0, 'major_outage');
        pages.setService(shop, 4, 'degraded');
        const shopDown = pages.openIncident(shop, { severity: 'critical' });
        const apiSlow = pages.openIncident(api, { severity: 'minor' });
        pages.setService(api, 2, 'partial_outage');
        await world.converge();
        await world.quiet(bot);

        // It develops.
        pages.updateIncident(shop, shopDown);
        pages.updateIncident(shop, shopDown);
        pages.updateIncident(api, apiSlow);
        await world.converge();

        // A typo in an update that is already posted gets corrected on the page.
        pages.editUpdate(shop, shopDown, 1, 'Ursache gefunden: ein defekter Switch im Rack 4');
        await world.converge();
        await world.quiet(bot);

        // An incident on the page that hides its history, resolved: the bot cannot see the
        // ending and must leave the thread where it was.
        const internal = pages.openIncident(hidden);
        pages.updateIncident(hidden, internal);
        await world.converge();
        pages.resolveIncident(hidden, internal);
        await world.converge();

        // Resolved, and everything green again.
        pages.resolveIncident(shop, shopDown);
        pages.setService(shop, 0, 'operational');
        pages.setService(shop, 4, 'operational');
        await world.converge();

        // One that should never have been published is taken down: its thread goes.
        pages.removeIncident(api, apiSlow);
        pages.setService(api, 2, 'operational');
        await world.converge();
        await world.quiet(bot, 4);

        world.clean();
        expect(await bot.stop()).toEqual({ code: 0, signal: null });
    });
});
