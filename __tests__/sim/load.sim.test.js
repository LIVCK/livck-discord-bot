/**
 * Many channels at once — the shape of the production freeze this branch started with.
 *
 * A restart with hundreds of subscriptions sends every status message in one cycle; an outage
 * that hits every page at once sends an announcement and its updates to every channel on top.
 * Discord allows 50 requests a second for the whole bot and five per channel per five seconds.
 * The bot must stay inside both, get every channel right in the end, never post anything twice,
 * and put incidents ahead of status edits — a reader waiting for "is it down?" should not wait
 * for two hundred unchanged-looking embeds to be refreshed first.
 *
 * SIM_SCALE multiplies the size (default 1: 30 pages, 150 subscriptions in 25 guilds).
 */

import { jest } from '@jest/globals';
import { createWorld, enabled } from './harness/world.js';

const maybe = enabled ? describe : describe.skip;
const SCALE = Number(process.env.SIM_SCALE || 1);
jest.setTimeout(600_000 * SCALE);

const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
};

maybe(`load (scale ${SCALE})`, () => {
    let world;
    afterEach(async () => { await world?.close(); });

    test('a restart with every status due, then an outage on every page at once', async () => {
        world = await createWorld();
        const { pages, discord } = world;

        const pageCount = 30 * SCALE;
        const guildCount = 25 * SCALE;
        const perPage = 5;
        const slugs = Array.from({ length: pageCount }, (_, i) => world.page({ name: `Kunde ${i + 1}`, groups: 2 + (i % 3), services: 4 + (i % 5) }));
        const guilds = Array.from({ length: guildCount }, () => world.guild());
        const layouts = ['DETAILED', 'COMPACT', 'OVERVIEW', 'MINIMAL', 'TREE'];
        let n = 0;
        for (const slug of slugs) {
            for (let k = 0; k < perPage; k += 1) {
                const guild = guilds[n % guilds.length];
                await world.subscribe({ guild, channel: world.channel(guild), page: slug, layout: layouts[n % 5], locale: n % 2 ? 'en' : 'de' });
                n += 1;
            }
        }

        const started = Date.now();
        const bot = await world.start();
        const firstPass = await world.converge({ timeout: 120_000 * SCALE });
        console.log(`[load] ${n} subscriptions: every status message in ${((Date.now() - started) / 1000).toFixed(1)}s (converged ${(firstPass / 1000).toFixed(1)}s after login)`);
        await world.quiet(bot);

        // Everything goes down at once.
        const outageAt = Date.now();
        const incidents = slugs.map((slug) => {
            pages.setService(slug, 0, 'major_outage');
            return pages.openIncident(slug, { severity: 'critical' });
        });
        const took = await world.converge({ timeout: 180_000 * SCALE });

        // When did each channel get its announcement, and when its status edit?
        const posts = discord.log.filter((e) => e.at >= outageAt && e.method === 'POST' && e.status === 200 && !e.body?.message_reference);
        const edits = discord.log.filter((e) => e.at >= outageAt && e.method === 'PATCH' && e.status === 200);
        const announced = median(posts.map((e) => e.at - outageAt));
        const edited = median(edits.map((e) => e.at - outageAt));
        console.log(`[load] outage on ${pageCount} pages: converged in ${(took / 1000).toFixed(1)}s; median announcement ${announced}ms, median status edit ${edited}ms; invalid peak ${discord.invalidRequestPeak()}`);
        expect(posts.length).toBeGreaterThanOrEqual(n);
        expect(announced).toBeLessThanOrEqual(edited);

        // It develops everywhere, twice, then resolves everywhere.
        for (let round = 0; round < 2; round += 1) {
            slugs.forEach((slug, i) => pages.updateIncident(slug, incidents[i]));
            await world.converge({ timeout: 180_000 * SCALE });
        }
        slugs.forEach((slug, i) => {
            pages.resolveIncident(slug, incidents[i]);
            pages.setService(slug, 0, 'operational');
        });
        await world.converge({ timeout: 180_000 * SCALE });
        await world.quiet(bot);

        world.clean();
        // A few 429s from the per-channel bucket are how discord.js learns it; a storm is not.
        expect(discord.invalidRequestPeak()).toBeLessThan(25 * SCALE);
    });
});
