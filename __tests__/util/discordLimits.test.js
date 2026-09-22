import { EmbedBuilder } from 'discord.js';
import {
    DISCORD_LIMITS,
    capFields,
    embedLength,
    enforceMessageBudget,
    joinWithinLimit,
    padInlineRows,
    truncate,
} from '../../util/discordLimits.js';

describe('truncate', () => {
    test('leaves text that fits untouched', () => {
        expect(truncate('hello', 10)).toBe('hello');
        expect(truncate('hello', 5)).toBe('hello');
    });

    test('marks the cut with an ellipsis and never exceeds max', () => {
        const result = truncate('abcdefghij', 5);
        expect(result).toHaveLength(5);
        expect(result.endsWith('…')).toBe(true);
    });

    test('handles nullish input', () => {
        expect(truncate(null, 10)).toBe('');
        expect(truncate(undefined, 10)).toBe('');
    });
});

describe('joinWithinLimit', () => {
    test('returns the plain join when everything fits', () => {
        expect(joinWithinLimit(['a', 'b', 'c'], { max: 100 })).toBe('a\nb\nc');
    });

    test('drops whole lines rather than cutting mid-line', () => {
        const lines = ['aaaa', 'bbbb', 'cccc', 'dddd'];
        const result = joinWithinLimit(lines, { max: 15, more: (n) => `+${n}` });

        expect(result.length).toBeLessThanOrEqual(15);
        for (const line of result.split('\n')) {
            expect(['aaaa', 'bbbb', 'cccc', 'dddd', line.startsWith('+') ? line : null]).toContain(line);
        }
    });

    test('reports how many lines were dropped', () => {
        const lines = Array.from({ length: 50 }, (_, i) => `service-${i}`);
        const result = joinWithinLimit(lines, { max: 60, more: (n) => `+${n} more` });

        expect(result.length).toBeLessThanOrEqual(60);
        const overflow = result.split('\n').at(-1);
        expect(overflow).toMatch(/^\+\d+ more$/);

        const dropped = Number(overflow.match(/\+(\d+)/)[1]);
        const kept = result.split('\n').length - 1;
        expect(kept + dropped).toBe(50);
    });

    test('empty input yields an empty string', () => {
        expect(joinWithinLimit([], { max: 100 })).toBe('');
        expect(joinWithinLimit(null, { max: 100 })).toBe('');
    });

    test('a single line longer than the budget is still truncated to fit', () => {
        const result = joinWithinLimit(['x'.repeat(500)], { max: 50, more: (n) => `+${n}` });
        expect(result.length).toBeLessThanOrEqual(50);
    });
});

describe('capFields', () => {
    const build = (count) => Array.from({ length: count }, (_, i) => ({
        name: `Category ${i}`,
        value: `value ${i}`,
        inline: false,
    }));

    test('leaves a list within the limit untouched', () => {
        expect(capFields(build(10))).toHaveLength(10);
    });

    test('never returns more than 25 fields', () => {
        const result = capFields(build(200), { more: (n) => ({ name: 'More', value: `${n}` }) });
        expect(result).toHaveLength(DISCORD_LIMITS.EMBED_FIELDS);
    });

    test('the overflow field accounts for every dropped entry', () => {
        const result = capFields(build(40), { more: (n) => ({ name: 'More', value: `${n} left` }) });
        expect(result.at(-1).value).toBe('16 left');
        expect(24 + 16).toBe(40);
    });

    test('clamps oversized field names and values', () => {
        const result = capFields([{ name: 'n'.repeat(500), value: 'v'.repeat(5000) }]);
        expect(result[0].name.length).toBeLessThanOrEqual(DISCORD_LIMITS.EMBED_FIELD_NAME);
        expect(result[0].value.length).toBeLessThanOrEqual(DISCORD_LIMITS.EMBED_FIELD_VALUE);
    });
});

describe('padInlineRows', () => {
    const inline = (count) => Array.from({ length: count }, () => ({ name: 'a', value: 'b', inline: true }));

    test('fills the last row to a multiple of three', () => {
        expect(padInlineRows(inline(4))).toHaveLength(6);
        expect(padInlineRows(inline(5))).toHaveLength(6);
    });

    test('does nothing when rows are already full', () => {
        expect(padInlineRows(inline(6))).toHaveLength(6);
    });

    test('refuses to pad past the field limit', () => {
        // 25 fields: padding to 27 would break Discord's cap, so the list is left as is.
        expect(padInlineRows(inline(25))).toHaveLength(25);
    });
});

describe('enforceMessageBudget', () => {
    test('leaves a normal embed alone', () => {
        const embed = new EmbedBuilder().setTitle('Status').setDescription('All good');
        const [result] = enforceMessageBudget([embed]);
        expect(result.toJSON().description).toBe('All good');
    });

    test('brings an oversized embed under the 6000 character budget', () => {
        const embed = new EmbedBuilder().setTitle('Status').setFields(
            Array.from({ length: 25 }, (_, i) => ({
                name: `Field ${i}`,
                value: 'x'.repeat(1000),
                inline: false,
            }))
        );

        expect(embedLength(embed.toJSON())).toBeGreaterThan(DISCORD_LIMITS.MESSAGE_EMBED_TOTAL);

        const [result] = enforceMessageBudget([embed], (n) => ({ name: 'More', value: `${n}` }));
        expect(embedLength(result.toJSON())).toBeLessThanOrEqual(DISCORD_LIMITS.MESSAGE_EMBED_TOTAL);
    });

    test('caps the number of embeds per message', () => {
        const embeds = Array.from({ length: 30 }, () => new EmbedBuilder().setTitle('x'));
        expect(enforceMessageBudget(embeds)).toHaveLength(DISCORD_LIMITS.EMBEDS_PER_MESSAGE);
    });

    test('counts title, description, footer, author and fields', () => {
        const embed = new EmbedBuilder()
            .setTitle('abc')
            .setDescription('de')
            .setFooter({ text: 'f' })
            .setAuthor({ name: 'gh' })
            .setFields([{ name: 'i', value: 'jk' }]);

        expect(embedLength(embed.toJSON())).toBe(3 + 2 + 1 + 2 + 1 + 2);
    });
});
