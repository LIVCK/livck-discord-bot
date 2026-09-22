/**
 * Which language a reader gets when the API stops offering theirs.
 *
 * There are TWO independent chains, and conflating them is how a bot ends up showing a
 * translation key to a customer:
 *
 *   CUSTOMER CONTENT — page, group and service names, incident titles and bodies. These arrive
 *   from the status page as a map of locale to text, and are resolved here: requested locale →
 *   the PAGE's own default → the first remaining language in sorted order → the caller's
 *   fallback. Sorted, not object-key order, so the same payload always renders the same way.
 *
 *   THE BOT'S OWN WORDS — "Services from", "no services", the pause footer. Those come from
 *   lang/*.json and fall back to English (see localeFallback.test.js).
 *
 * A French subscription on a page that has dropped French therefore shows the page's German
 * service names under English labels. Each half gives the best it has, and neither shows a key.
 */

import { resolveText } from '../../dto/statuspage.js';

const NAMES = { de: 'Datenbank', en: 'Database', fr: 'Base de données' };

describe('the language the reader asked for', () => {
    test('is used when the page still offers it', () => {
        expect(resolveText(NAMES, 'fr', 'de')).toBe('Base de données');
    });

    test('gives way to the page default when it disappears', () => {
        const { fr, ...withoutFrench } = NAMES;
        expect(resolveText(withoutFrench, 'fr', 'de')).toBe('Datenbank');
    });

    test('and then to whatever is left, when the default is gone too', () => {
        // Sorted order decides, so `en` wins over `es` — the point is that SOMETHING readable
        // comes back, and that the same payload always picks the same one.
        expect(resolveText({ en: 'Database', es: 'Base' }, 'fr', 'de')).toBe('Database');
        expect(resolveText({ es: 'Base', zh: '数据库' }, 'fr', 'de')).toBe('Base');
    });

    test('even when what is left is a language nobody configured', () => {
        expect(resolveText({ zh: '数据库' }, 'fr', 'de')).toBe('数据库');
    });
});

describe('the shapes an API really sends', () => {
    test.each([
        ['a cleared translation stored as null', { de: null, en: 'Database' }, 'Database'],
        ['a cleared translation stored as ""', { de: '', en: 'Database' }, 'Database'],
        ['a plain string, which is what self-hosted sends', 'Datenbank', 'Datenbank'],
    ])('%s', (_label, value, expected) => {
        expect(resolveText(value, 'de', 'de', 'FALLBACK')).toBe(expected);
    });

    test.each([
        ['every language empty', { de: '', en: '' }],
        ['an empty map', {}],
        ['null', null],
        ['undefined', undefined],
        ['a number', 12345],
        ['an array', []],
    ])('%s reaches the caller fallback rather than crashing or leaking', (_label, value) => {
        expect(resolveText(value, 'de', 'de', 'FALLBACK')).toBe('FALLBACK');
    });

    test('and with no fallback given it is an empty string, never undefined', () => {
        // An `undefined` here would reach Discord as the literal word.
        expect(resolveText(null, 'de', 'de')).toBe('');
        expect(resolveText({}, 'de', 'de')).toBe('');
    });
});

describe('the choice of last resort', () => {
    test('is deterministic, whatever order the API serialises its keys in', () => {
        // Object-key order would make the same page render differently between two cycles,
        // which changes the content hash and edits every message for nothing.
        const orders = [
            { zh: 'C', ar: 'A', pl: 'B' },
            { pl: 'B', zh: 'C', ar: 'A' },
            { ar: 'A', pl: 'B', zh: 'C' },
        ];

        const resolved = orders.map((value) => resolveText(value, 'fr', 'de'));
        expect(new Set(resolved).size).toBe(1);
        expect(resolved[0]).toBe('A');
    });

    test('skips an empty language rather than picking it because it sorts first', () => {
        expect(resolveText({ aa: '', bb: 'Zweite' }, 'fr', 'de')).toBe('Zweite');
    });
});
