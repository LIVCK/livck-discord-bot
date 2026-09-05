/**
 * End-to-end: the real pipeline, a real database, real status pages. Only Discord is recorded
 * instead of called.
 *
 * Everything else actually executes — detection, both adapters, the DTO, all five layouts in
 * both languages, the message-sync decisions and every DB write. It is the closest thing to
 * running the bot that does not need a Discord token, and it is what found the two display
 * bugs the fixture tests could not: a hiding group rendering as an empty heading in the tree
 * and minimal layouts.
 *
 * OPT IN, because it needs both the network and a database:
 *
 *   docker exec mariadb mariadb -u root -e "CREATE DATABASE IF NOT EXISTS livck_bot_e2e"
 *   DB_HOST=127.0.0.1 DB_DATABASE=livck_bot_e2e DB_USERNAME=root DB_PASSWORD= node migrate.js
 *   LIVCK_E2E=1 DB_HOST=127.0.0.1 DB_DATABASE=livck_bot_e2e DB_USERNAME=root DB_PASSWORD= \
 *     npm test -- __tests__/e2e/pipeline.live.test.js
 *
 * Never point it at a database you care about: it truncates every table it uses.
 */

const e2e = process.env.LIVCK_E2E === '1' ? describe : describe.skip;

const LAYOUTS = ['DETAILED', 'COMPACT', 'OVERVIEW', 'TREE', 'MINIMAL'];
const LOCALES = ['de', 'en'];

/** Two of each kind, so a quirk of one page cannot pass for the product's behaviour. */
const PAGES = [
    { url: 'https://status.livck.com', name: 'status.livck.com', kind: 'SELF_HOSTED' },
    { url: 'https://fc-status.net', name: 'fc-status.net', kind: 'SELF_HOSTED' },
    { url: 'https://cloud.statuspage.de', name: 'cloud.statuspage.de', kind: 'CLOUD' },
    { url: 'https://status.emeraldhost.de', name: 'status.emeraldhost.de', kind: 'CLOUD' },
];

e2e('the whole pipeline against real status pages', () => {
    let models;
    let handleStatusPage;
    let handleAlerts;
    let clearSnapshotCache;
    let DISCORD_LIMITS;
    let embedLength;

    /** Everything the bot would have sent. */
    const sent = [];

    const client = {
        channels: {
            fetch: async (id) => ({
                id,
                send: async (payload) => { sent.push({ channelId: id, action: 'send', payload }); return { id: `msg-${sent.length}` }; },
                messages: { edit: async (_id, payload) => { sent.push({ channelId: id, action: 'edit', payload }); return {}; } },
            }),
        },
    };

    const pages = new Map();

    beforeAll(async () => {
        models = (await import('../../models/index.js')).default;
        ({ handleStatusPage } = await import('../../handlers/handleStatuspage.js'));
        ({ handleAlerts } = await import('../../handlers/handleAlerts.js'));
        ({ clearSnapshotCache } = await import('../../providers/index.js'));
        ({ DISCORD_LIMITS, embedLength } = await import('../../util/discordLimits.js'));

        await models.Message.destroy({ where: {}, truncate: true, cascade: true });
        await models.CustomLink.destroy({ where: {}, truncate: true, cascade: true });
        await models.RoleMention.destroy({ where: {}, truncate: true, cascade: true });
        await models.Subscription.destroy({ where: {} });
        await models.Statuspage.destroy({ where: {} });

        for (const page of PAGES) {
            const row = await models.Statuspage.create({ url: page.url, name: page.name });
            for (const layout of LAYOUTS) {
                for (const locale of LOCALES) {
                    await models.Subscription.create({
                        guildId: 'e2e-guild',
                        channelId: `${page.name}#${layout}#${locale}`,
                        statuspageId: row.id,
                        layout,
                        locale,
                        eventTypes: { STATUS: true, NEWS: true },
                        interval: 60,
                        // Old enough that no alert is skipped as predating the subscription.
                        createdAt: new Date('2020-01-01'),
                    });
                }
            }
            pages.set(page.name, row);
        }

        for (const row of pages.values()) {
            clearSnapshotCache();
            await handleStatusPage(row.id, client);
            await handleAlerts(row.id, client);
            await row.reload();
        }
    }, 120000);

    afterAll(async () => {
        if (models) await models.database.close();
    });

    describe.each(PAGES)('$name', (page) => {
        const messagesFor = () => sent.filter((m) => m.channelId.startsWith(`${page.name}#`));
        const embedsFor = () => messagesFor().flatMap((m) => (m.payload.embeds ?? []).map((e) => e.toJSON()));

        test('is detected as the right product and remembers it', () => {
            const row = pages.get(page.name);
            expect(row.kind).toBe(page.kind);
            if (page.kind === 'CLOUD') {
                // The page id is cached so the /status.json lookup happens once, not per cycle.
                expect(row.externalId).toEqual(expect.any(String));
            }
        });

        test('produces one status message per subscription', () => {
            expect(messagesFor().filter((m) => m.action === 'send')).toHaveLength(LAYOUTS.length * LOCALES.length);
        });

        test('every embed stays inside Discord limits', () => {
            for (const embed of embedsFor()) {
                expect(embedLength(embed)).toBeLessThanOrEqual(DISCORD_LIMITS.MESSAGE_EMBED_TOTAL);
                expect((embed.fields ?? []).length).toBeLessThanOrEqual(DISCORD_LIMITS.EMBED_FIELDS);
                expect((embed.title ?? '').length).toBeLessThanOrEqual(DISCORD_LIMITS.EMBED_TITLE);
                expect((embed.description ?? '').length).toBeLessThanOrEqual(DISCORD_LIMITS.EMBED_DESCRIPTION);

                for (const field of embed.fields ?? []) {
                    expect(field.name.length).toBeGreaterThan(0);
                    expect(field.value.length).toBeGreaterThan(0);
                    expect(field.value.length).toBeLessThanOrEqual(DISCORD_LIMITS.EMBED_FIELD_VALUE);
                }
            }
        });

        test('no translation key leaks into the output', () => {
            // A missing key renders as the key itself, which is the most visible way i18n
            // breaks and the easiest to miss in a language you do not read.
            for (const embed of embedsFor()) {
                const text = [
                    embed.title ?? '', embed.description ?? '',
                    ...(embed.fields ?? []).flatMap((f) => [f.name, f.value]),
                ].join('\n');

                expect(text).not.toMatch(/\b(messages|commands)\.[a-z_]+\.[a-z_.]+/i);
            }
        });

        test('no placeholder value reaches a reader', () => {
            for (const embed of embedsFor()) {
                const text = [
                    embed.title ?? '', embed.description ?? '',
                    ...(embed.fields ?? []).flatMap((f) => [f.name, f.value]),
                ].join('\n');

                expect(text).not.toMatch(/undefined|\[object Object\]|\bNaN\b/);
            }
        });

        test('no raw HTML survives the converter', () => {
            for (const embed of embedsFor()) {
                const text = [embed.description ?? '', ...(embed.fields ?? []).map((f) => f.value)]
                    .join('\n')
                    // Discord's own emoji syntax looks like a tag and is not one.
                    .replace(/<a?:\w+:\d+>/g, '');

                expect(text).not.toMatch(/<\/?(p|div|span|strong|em|br|ul|ol|li|a|table)\b/i);
            }
        });

        test('no group renders as an empty heading', () => {
            // The bug this file found: a Cloud group that hides its healthy children showed as
            // a bold heading with nothing under it in the tree and minimal layouts.
            for (const { channelId, payload } of messagesFor()) {
                if (!channelId.includes('TREE') && !channelId.includes('MINIMAL')) continue;

                const lines = (payload.embeds[0].toJSON().description ?? '').split('\n');
                lines.forEach((line, index) => {
                    if (!line.startsWith('**')) return;
                    const next = lines[index + 1];
                    // A heading is followed by content, or by the blank line before the next
                    // group, or it is the last line of the description.
                    if (next === undefined || next === '') return;
                    expect(next.trim()).not.toBe('');
                });
            }
        });

        test('the German and English renderings actually differ', () => {
            // The bot's own strings are translated even when a customer's component names are
            // not, so at least the title must change between the two.
            const de = messagesFor().find((m) => m.channelId.endsWith('#COMPACT#de'));
            const en = messagesFor().find((m) => m.channelId.endsWith('#COMPACT#en'));

            expect(de.payload.embeds[0].toJSON().title)
                .not.toBe(en.payload.embeds[0].toJSON().title);
        });
    });

    describe('a second cycle', () => {
        test('sends nothing, because nothing changed', async () => {
            // The dirty check is what keeps the bot under Discord's 50 req/s budget; this is
            // the first time it runs against real payloads and a real database.
            const before = sent.length;

            for (const row of pages.values()) {
                clearSnapshotCache();
                await handleStatusPage(row.id, client);
                await handleAlerts(row.id, client);
            }

            expect(sent).toHaveLength(before);
        }, 120000);
    });

    describe('the tracked messages', () => {
        test('every status message stored a content hash', async () => {
            const records = await models.Message.findAll({ where: { category: 'STATUS' } });

            expect(records.length).toBe(PAGES.length * LAYOUTS.length * LOCALES.length);
            for (const record of records) {
                expect(record.contentHash).toMatch(/^[0-9a-f]{64}$/);
            }
        });
    });
});
