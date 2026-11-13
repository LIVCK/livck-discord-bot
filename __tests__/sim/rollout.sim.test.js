/**
 * A rollout, for real: the version that is deployed builds up a production state — status
 * messages, open incidents with replies, a finished one — and is stopped the way a deploy
 * stops it. The version under test starts on the same database and the same channels.
 *
 * What it must do on its first cycles is NOTHING. Not one request to Discord: no message
 * posted again, none edited, none deleted. Anything else means every customer channel changes
 * the moment the deploy lands. After that it must carry on with what the old version started —
 * replying in threads it did not open, closing incidents it did not announce.
 *
 * The deployed version is a checkout of the bot with its dependencies installed, named by
 * SIM_BASELINE_DIR (CI builds it from SIM_BASELINE_REF; see .github/workflows/test.yml).
 */

import fs from 'node:fs';
import path from 'node:path';
import { jest } from '@jest/globals';
import { createWorld, enabled } from './harness/world.js';

const baseline = process.env.SIM_BASELINE_DIR;
const ready = enabled && baseline && fs.existsSync(path.join(baseline, 'server.js'));
const maybe = ready ? describe : describe.skip;
jest.setTimeout(300_000);

maybe('rolling out over the deployed version', () => {
    let world;
    afterEach(async () => { await world?.close(); });

    test('the new version changes nothing in any channel, then carries on where the old one stopped', async () => {
        world = await createWorld();
        const { pages } = world;

        const shop = world.page({ name: 'Shop', groups: 3, services: 9 });
        const api = world.page({ name: 'API', groups: 2, services: 4 });
        const layouts = ['DETAILED', 'COMPACT', 'OVERVIEW', 'MINIMAL', 'TREE'];
        let n = 0;
        for (let g = 0; g < 4; g += 1) {
            const guild = world.guild();
            for (const page of [shop, api]) {
                await world.subscribe({
                    guild, channel: world.channel(guild), page,
                    layout: layouts[n % layouts.length], locale: n % 2 ? 'en' : 'de',
                });
                n += 1;
            }
        }

        // The deployed version builds the state the new one inherits.
        const old = await world.start({ cwd: baseline, label: 'deployed', env: { SIM_FORCE_INTERVAL_MS: '1000' } });
        pages.setService(shop, 1, 'major_outage');
        const running = pages.openIncident(shop, { severity: 'critical' });
        const finished = pages.openIncident(api);
        await old.cycles(4);
        pages.updateIncident(shop, running);
        pages.updateIncident(api, finished);
        await old.cycles(4);
        pages.resolveIncident(api, finished);
        await old.cycles(6);
        await world.quiet(old, 3);
        expect(await old.stop()).toEqual({ code: 0, signal: null });

        // The deploy.
        const since = Date.now();
        const next = await world.start({ label: 'new' });
        await next.cycles(5);
        const touched = world.discord.requestsSince(since, (e) => e.channelId);
        if (touched.length > 0) {
            throw new Error(`The new version touched ${touched.length} message(s) on its first cycles:\n  `
                + touched.slice(0, 15).map((e) => `${e.method} ${e.url} → ${e.status}`).join('\n  '));
        }
        // And what it inherited is exactly what it would have made itself.
        await world.converge({ timeout: 5000 });

        // Then life goes on, in threads the old version opened.
        pages.updateIncident(shop, running);
        pages.resolveIncident(shop, running);
        pages.setService(shop, 1, 'operational');
        await world.converge();
        await world.quiet(next);
        world.clean();
    });
});
