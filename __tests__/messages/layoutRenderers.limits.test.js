/**
 * The layouts must survive status pages that are far larger than Discord allows.
 *
 * Discord answers an over-limit message with HTTP 400 and discards the entire message, so
 * an unguarded renderer means such a page posts NOTHING. These tests assert the guards hold
 * for input that is deliberately absurd; the golden test next door asserts they change
 * nothing for ordinary input.
 */

import { DISCORD_LIMITS, embedLength } from '../../util/discordLimits.js';
import {
    renderCompactLayout,
    renderDetailedLayout,
    renderMinimalLayout,
    renderOverviewLayout,
    renderTreeLayout,
} from '../../messages/layoutRenderers.js';

const STATUSPAGE = { name: 'huge.example.com', url: 'https://huge.example.com' };

/** A page with far more categories and services than Discord can display. */
const hugeService = ({ categories = 60, monitorsPerCategory = 80, nameLength = 40 } = {}) => ({
    categories: Array.from({ length: categories }, (_, c) => ({
        id: `cat-${c}`,
        name: `Kategorie ${c} ${'x'.repeat(nameLength)}`,
        monitors: Array.from({ length: monitorsPerCategory }, (_, m) => ({
            id: `mon-${c}-${m}`,
            name: `Service ${c}-${m} ${'y'.repeat(nameLength)}`,
            state: m % 3 === 0 ? 'UNAVAILABLE' : 'AVAILABLE',
        })),
    })),
});

const LAYOUTS = [
    ['DETAILED', renderDetailedLayout],
    ['COMPACT', renderCompactLayout],
    ['OVERVIEW', renderOverviewLayout],
    ['TREE', renderTreeLayout],
    ['MINIMAL', renderMinimalLayout],
];

describe.each(LAYOUTS)('%s stays within Discord limits', (name, renderer) => {
    const rendered = renderer(hugeService(), STATUSPAGE, 'de');
    const embeds = rendered.map(({ embed }) => embed.toJSON());

    test('at most 10 embeds per message', () => {
        expect(embeds.length).toBeLessThanOrEqual(DISCORD_LIMITS.EMBEDS_PER_MESSAGE);
    });

    test('at most 25 fields per embed', () => {
        for (const embed of embeds) {
            expect((embed.fields || []).length).toBeLessThanOrEqual(DISCORD_LIMITS.EMBED_FIELDS);
        }
    });

    test('field names and values stay within their limits', () => {
        for (const embed of embeds) {
            for (const field of embed.fields || []) {
                expect(field.name.length).toBeLessThanOrEqual(DISCORD_LIMITS.EMBED_FIELD_NAME);
                expect(field.value.length).toBeLessThanOrEqual(DISCORD_LIMITS.EMBED_FIELD_VALUE);
                // Discord rejects an empty field value outright.
                expect(field.value.length).toBeGreaterThan(0);
            }
        }
    });

    test('title and description stay within their limits', () => {
        for (const embed of embeds) {
            expect((embed.title || '').length).toBeLessThanOrEqual(DISCORD_LIMITS.EMBED_TITLE);
            expect((embed.description || '').length).toBeLessThanOrEqual(DISCORD_LIMITS.EMBED_DESCRIPTION);
        }
    });

    test('combined embed length stays within the 6000 character budget', () => {
        const total = embeds.reduce((sum, embed) => sum + embedLength(embed), 0);
        expect(total).toBeLessThanOrEqual(DISCORD_LIMITS.MESSAGE_EMBED_TOTAL);
    });
});

describe('overflow is reported, not silently dropped', () => {
    test('DETAILED names the categories it could not show', () => {
        const [{ embed }] = renderDetailedLayout(hugeService({ categories: 60 }), STATUSPAGE, 'de');
        const json = embed.toJSON();

        expect(json.fields.length).toBeLessThanOrEqual(DISCORD_LIMITS.EMBED_FIELDS);
        expect(embedLength(json)).toBeLessThanOrEqual(DISCORD_LIMITS.MESSAGE_EMBED_TOTAL);

        // The overflow count must cover EVERY missing category — both the ones the 25-field
        // cap dropped and the ones the character budget dropped afterwards.
        const shown = json.fields.length - 1;
        const hidden = Number(json.fields.at(-1).value.match(/(\d+)/)[1]);
        expect(shown + hidden).toBe(60);
    });

    test('a category with too many services says how many are missing', () => {
        const service = {
            categories: [{
                id: 'c',
                name: 'Viele',
                monitors: Array.from({ length: 200 }, (_, i) => ({
                    id: `m${i}`, name: `Service ${i}`, state: 'AVAILABLE',
                })),
            }],
        };

        const [{ embed }] = renderDetailedLayout(service, STATUSPAGE, 'de');
        const value = embed.toJSON().fields[0].value;

        expect(value.length).toBeLessThanOrEqual(DISCORD_LIMITS.EMBED_FIELD_VALUE);
        expect(value.split('\n').at(-1)).toMatch(/\d+/);
    });
});

describe('degenerate input does not throw', () => {
    const cases = [
        ['no categories', { categories: [] }],
        ['missing categories key', {}],
        ['category without monitors', { categories: [{ id: 'a', name: 'Leer', monitors: [] }] }],
        ['monitors not an array', { categories: [{ id: 'a', name: 'Kaputt', monitors: null }] }],
        ['nameless category', { categories: [{ id: 'a', name: null, monitors: [{ id: 'm', name: 'S', state: 'AVAILABLE' }] }] }],
        ['unknown monitor state', { categories: [{ id: 'a', name: 'X', monitors: [{ id: 'm', name: 'S', state: 'WAT' }] }] }],
    ];

    describe.each(LAYOUTS)('%s', (name, renderer) => {
        test.each(cases)('%s', (_label, service) => {
            expect(() => renderer(service, STATUSPAGE, 'de')).not.toThrow();
        });
    });
});
