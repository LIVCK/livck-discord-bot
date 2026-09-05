/**
 * Three ways a status page could be silenced by its own content.
 *
 * All three were found by fuzzing the real renderers rather than by reading them, and each
 * one ends with a customer seeing nothing — either because the render throws before Discord
 * is reached, or because Discord rejects the finished message whole.
 */

import { getLayoutRenderer } from '../../messages/layoutRenderers.js';
import { STATUS, SOURCE, makeSnapshot, makeGroup, makeService } from '../../dto/statuspage.js';
import { embedLength, DISCORD_LIMITS, padInlineRows } from '../../util/discordLimits.js';
import { markdownToDiscord } from '../../util/markdown.js';

const LAYOUTS = ['DETAILED', 'COMPACT', 'OVERVIEW', 'TREE', 'MINIMAL'];

const snapshot = ({ name = 'Example', groups = 1, groupNameLength = 6 } = {}) => makeSnapshot({
    source: SOURCE.CLOUD,
    url: 'https://status.example.com',
    name: { de: name },
    overall: STATUS.OPERATIONAL,
    defaultLocale: 'de',
    locales: ['de'],
    groups: Array.from({ length: groups }, (_, i) => makeGroup({
        id: `g${i}`,
        name: { de: `G${String(i).padStart(3, '0')} ${'x'.repeat(groupNameLength)}` },
        status: STATUS.OPERATIONAL,
        services: [makeService({ id: `s${i}`, name: { de: 'API' }, status: STATUS.OPERATIONAL })],
    })),
    alerts: [],
});

describe('a page whose name is longer than a Discord title', () => {
    // `Statuspage.name` is a VARCHAR(255) and the title breaks at 245, so the database stores
    // ten more characters than the renderer used to survive — and a Cloud page's name is not
    // length-bounded by the bot at all. EmbedBuilder validates on construction and THROWS, so
    // every layout died before any limit guard ran. The handler catches it per subscription,
    // which means the status message freezes on its last content for ever, for every
    // subscriber of that page, with one log line and nothing a reader could see.
    test.each(LAYOUTS)('%s still renders', (layout) => {
        const render = getLayoutRenderer(layout);

        expect(() => render(snapshot({ name: 'A'.repeat(500) }), 'de')).not.toThrow();

        const [{ embed }] = render(snapshot({ name: 'A'.repeat(500) }), 'de');
        const json = embed.toJSON();
        expect(json.title.length).toBeLessThanOrEqual(DISCORD_LIMITS.EMBED_TITLE);
        expect(json.footer.text.length).toBeLessThanOrEqual(DISCORD_LIMITS.EMBED_FOOTER_TEXT);
    });

    test('the empty-page fallback survives it too', () => {
        const render = getLayoutRenderer('DETAILED');
        const bare = makeSnapshot({
            source: SOURCE.CLOUD, url: 'https://status.example.com',
            name: { de: 'A'.repeat(500) }, overall: STATUS.OPERATIONAL,
            defaultLocale: 'de', locales: ['de'], groups: [], alerts: [],
        });

        expect(() => render(bare, 'de')).not.toThrow();
    });
});

describe('the cosmetic padding of inline rows', () => {
    // Padding runs AFTER the budget has been enforced, and a zero-width space is still a
    // character to Discord. 22 groups with 229-character names landed at 5998 and the two
    // filler fields took it to 6002 — Discord answers 400 and drops the message, so the page
    // posts nothing at all. Cosmetics never win over delivering the message.
    test('never pushes a message past the 6000-character budget', () => {
        const render = getLayoutRenderer('COMPACT');
        const [{ embed }] = render(snapshot({ groups: 22, groupNameLength: 229 }), 'de');

        expect(embedLength(embed.toJSON())).toBeLessThanOrEqual(DISCORD_LIMITS.MESSAGE_EMBED_TOTAL);
    });

    test('is skipped rather than applied when it would not fit', () => {
        const fields = [{ name: 'a', value: 'b', inline: true }];

        expect(padInlineRows(fields, { used: DISCORD_LIMITS.MESSAGE_EMBED_TOTAL })).toHaveLength(1);
        expect(padInlineRows(fields, { used: 0 })).toHaveLength(3);
    });

    test('no layout exceeds a limit for any group count and name length', () => {
        // The fuzz that found it, kept as a test.
        for (const layout of LAYOUTS) {
            const render = getLayoutRenderer(layout);
            for (let groups = 3; groups <= 40; groups += 1) {
                for (const groupNameLength of [0, 1, 40, 100, 228, 229, 230, 255, 300]) {
                    for (const { embed } of render(snapshot({ groups, groupNameLength }), 'de')) {
                        const json = embed.toJSON();
                        expect(embedLength(json)).toBeLessThanOrEqual(DISCORD_LIMITS.MESSAGE_EMBED_TOTAL);
                        expect((json.fields ?? []).length).toBeLessThanOrEqual(DISCORD_LIMITS.EMBED_FIELDS);
                    }
                }
            }
        }
    }, 60000);
});

describe('stripping HTML out of a markdown body', () => {
    // The old pattern was "anything between angle brackets", which treats ordinary prose as
    // markup — and Discord's own syntax is written the same way.
    test.each([
        ['a comparison is not a tag', 'Latency spiked <500ms and >2s on node-4.'],
        ['neither is a threshold', 'Wir erwarten <1h Ausfall.'],
        ['nor an inequality in prose', 'Kunde meldete: a<b und b>c'],
        ['a Discord autolink survives', 'See <https://status.example/incident/42> for details.'],
        ['a custom emoji survives', 'Status: <:green_dot:123456789012345678> alles gut.'],
        ['a role mention survives', 'Ping <@&123456789012345678> bitte.'],
    ])('%s', (_label, input) => {
        expect(markdownToDiscord(input)).toBe(input);
    });

    test.each([
        ['<p>Echtes HTML</p> soll weg.', 'Echtes HTML soll weg.'],
        ['Zeile<br/>Umbruch', 'ZeileUmbruch'],
        ['Zeile<br />Umbruch', 'ZeileUmbruch'],
        ['<a href="https://x.example">Link</a>', 'Link'],
        ['<div class="a"><span>tief</span></div>', 'tief'],
    ])('but real markup is still removed: %s', (input, expected) => {
        expect(markdownToDiscord(input)).toBe(expected);
    });

    test('a code fence keeps its tags', () => {
        const input = 'Beispiel:\n```html\n<p>bleibt</p>\n```';
        expect(markdownToDiscord(input)).toContain('<p>bleibt</p>');
    });
});
