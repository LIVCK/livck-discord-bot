/**
 * Everything at once, in an order nobody wrote down: a seeded random walk through incidents,
 * outages, faults, kicks, permission changes, deploys, crashes and gateway drops. Then the
 * weather clears — and every channel must be exactly right, the bot silent, the referee happy.
 *
 * The seed is printed. `SIM_SEED=<seed>` replays a run step for step; `SIM_CHAOS_RUNS` and
 * `SIM_CHAOS_STEPS` turn it up when hunting.
 */

import { jest } from '@jest/globals';
import { createWorld, enabled } from './harness/world.js';

const maybe = enabled ? describe : describe.skip;
const RUNS = Number(process.env.SIM_CHAOS_RUNS || 2);
const STEPS = Number(process.env.SIM_CHAOS_STEPS || 40);
jest.setTimeout(RUNS * (STEPS * 6_000 + 240_000));

/** mulberry32 — small, fast, and the same everywhere. */
const prng = (seed) => () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const FAULTS = ['hang', 'loseAnswer', 'badGateway', 'serverError', 'reset', 'rateLimited', { delayMs: 2000 }];
const STATUSES = ['operational', 'degraded', 'partial_outage', 'major_outage', 'under_maintenance'];

const runOnce = async (seed) => {
    const random = prng(seed);
    const pick = (list) => list[Math.floor(random() * list.length)];
    const steps = [];
    const world = await createWorld();
    const { pages, discord } = world;

    try {
        const slugs = Array.from({ length: 4 }, (_, i) => world.page({ name: `Chaos ${i + 1}`, groups: 2, services: 6, showHistory: i !== 3 }));
        const guilds = Array.from({ length: 5 }, () => world.guild());
        const channels = [];
        const layouts = ['DETAILED', 'COMPACT', 'OVERVIEW', 'MINIMAL', 'TREE'];
        for (let i = 0; i < 12; i += 1) {
            const guild = guilds[i % guilds.length];
            const channel = world.channel(guild);
            channels.push(channel);
            await world.subscribe({ guild, channel, page: slugs[i % slugs.length], layout: layouts[i % 5], locale: i % 3 ? 'de' : 'en', news: i % 5 !== 4 });
        }

        let bot = await world.start();
        const open = new Map(slugs.map((slug) => [slug, []]));

        const actions = [
            [6, 'open incident', () => { const slug = pick(slugs); open.get(slug).push(pages.openIncident(slug, { severity: pick(['minor', 'major', 'critical']) })); }],
            [8, 'update incident', () => { const slug = pick(slugs); const list = open.get(slug); if (list.length) pages.updateIncident(slug, pick(list)); }],
            [3, 'resolve incident', () => { const slug = pick(slugs); const list = open.get(slug); if (list.length) { const id = list.splice(Math.floor(random() * list.length), 1)[0]; pages.resolveIncident(slug, id); } }],
            [1, 'take incident down', () => { const slug = pick(slugs); const list = open.get(slug); if (list.length) { const id = list.splice(Math.floor(random() * list.length), 1)[0]; pages.removeIncident(slug, id); } }],
            [1, 'correct an update', () => { const slug = pick(slugs); const inc = pages.incidents(slug).find((i) => !i.removed && i.updates.length > 1); if (inc) pages.editUpdate(slug, inc.id, 1, `Korrigiert ${Math.floor(random() * 1e6)}`); }],
            [7, 'service status', () => { const slug = pick(slugs); pages.setService(slug, Math.floor(random() * 6), pick(STATUSES)); }],
            [5, 'channel fault', () => discord.fault(pick(channels), pick(FAULTS))],
            [4, 'channel heals', () => discord.fault(pick(channels), 'none')],
            [2, 'channel hidden', () => discord.setAccessQuietly(pick(channels), 'hidden')],
            [1, 'channel read-only', () => discord.setAccessQuietly(pick(channels), 'readonly')],
            [3, 'channel access back', () => discord.setAccess(pick(channels), 'ok')],
            [1, 'kick', () => { const guild = pick(guilds); if (discord.guild(guild).member && guilds.filter((g) => discord.guild(g).member).length > 2) discord.kick(guild); }],
            [1, 'gateway drop', () => discord.disconnectGateway(4000)],
            [1, 'deploy', async () => { await bot.stop(); bot = await world.start(); }],
            [1, 'crash', async () => { await bot.kill(); bot = await world.start(); }],
        ];
        const total = actions.reduce((sum, [weight]) => sum + weight, 0);

        for (let step = 0; step < STEPS; step += 1) {
            let roll = random() * total;
            const [, name, act] = actions.find(([weight]) => (roll -= weight) < 0);
            steps.push(name);
            await act();
            const wait = Math.floor(random() * 3);
            if (wait > 0) await bot.cycles(wait);
        }

        // The weather clears.
        steps.push('— heal everything —');
        discord.heal();
        for (const channel of channels) if (discord.channel(channel).access !== 'ok') discord.setAccess(channel, 'ok');
        await world.converge({ timeout: 120_000 });
        await world.quiet(bot, 4, { settle: 3 });
        world.clean();
        await bot.stop();
    } catch (error) {
        const named = new Set((error.message.match(/inc[0-9a-z]{6}/g) ?? []));
        const history = [...named].map((id) => {
            const slug = pages.pages().find((sl) => pages.page(sl).incidents.has(id));
            const inc = slug && pages.page(slug).incidents.get(id);
            return inc ? `  ${id} on ${pages.page(slug).name.de} (history ${pages.page(slug).showHistory ? 'shown' : 'hidden'}): ${inc.status}${inc.removed ? ', removed' : ''}, ${inc.updates.length} updates, seen live: ${Boolean(inc.seenLive)}` : `  ${id}: ?`;
        });
        let detail = '';
        if (process.env.SIM_DEBUG) {
            const channelIds = [...new Set(error.message.match(/channel (\d{19})/g)?.map((c) => c.slice(8)) ?? [])];
            for (const id of channelIds) {
                const reqs = discord.log.filter((e) => e.channelId === id).slice(-25)
                    .map((e) => `    ${new Date(e.at).toISOString().slice(11, 23)} ${e.method} ${e.url.replace(/.*channels\/\d+/, '')} → ${e.status}${e.deduplicated ? ' (dedup)' : ''}${e.body?.message_reference ? ` reply→${e.body.message_reference.message_id}` : ''} ${(e.body?.embeds?.[0]?.title ?? '').slice(0, 40)}`);
                const sub = (await world.subscriptions()).find((x) => x.channelId === id);
                const rows = sub ? await world.database.query('SELECT id, category, serviceId, messageId, contentHash, updatedAt FROM Messages WHERE subscriptionId = ?', [sub.id]) : [];
                const msgs = discord.messagesIn(id).map((m) => `    ${m.id} ${m.message_reference ? `↳${m.message_reference.message_id} ` : ''}${(m.embeds?.[0]?.title ?? '').slice(0, 50)}`);
                detail += `\n--- ${id}: requests\n${reqs.join('\n')}\n--- rows\n${rows.map((r) => `    ${r.id} ${r.category} ${r.serviceId} ${r.messageId} ${String(r.contentHash).slice(0, 10)} ${new Date(r.updatedAt).toISOString().slice(11, 23)}`).join('\n')}\n--- messages\n${msgs.join('\n')}`;
            }
        }
        error.message = `SIM_SEED=${seed}\nsteps: ${steps.join(' → ')}\n${error.message}\n--- incidents named above:\n${history.join('\n')}${detail}`;
        throw error;
    } finally {
        await world.close();
    }
};

maybe('chaos', () => {
    const base = Number(process.env.SIM_SEED || Date.now() % 1_000_000);
    for (let run = 0; run < RUNS; run += 1) {
        const seed = base + run;
        test(`seed ${seed}`, async () => {
            console.log(`[chaos] SIM_SEED=${seed}`);
            await runOnce(seed);
        });
    }
});
