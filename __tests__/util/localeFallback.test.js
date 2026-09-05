/**
 * The eleven community languages are PARTIAL by design.
 *
 * `crowdin.yml` sets `skip_untranslated_strings: true`, so a downloaded `fr.json` contains only
 * the strings somebody has actually translated — and the sync workflow commits exactly that
 * into `lang/`, from where it is baked into the image. Every key added since the last
 * translation round is therefore missing in all eleven of them, including the four this branch
 * adds.
 *
 * That makes the fallback load-bearing rather than a nicety: a key that does not resolve is
 * rendered as the key itself, so `messages.pause.footer` would appear verbatim in a French
 * customer's channel. Nothing tested it, and no partial locale ships in this branch to test
 * it against, so one is built here.
 */

import translation from '../../util/Translation.js';
import de from '../../lang/de.json' with { type: 'json' };
import en from '../../lang/en.json' with { type: 'json' };

/** Every leaf key, dotted. */
const flatten = (object, prefix = '') => Object.entries(object).flatMap(([key, value]) =>
    value && typeof value === 'object' && !Array.isArray(value)
        ? flatten(value, `${prefix}${key}.`)
        : [`${prefix}${key}`]);

const ALL_KEYS = flatten(en);

/** What Crowdin actually hands back: a handful of translated strings and nothing else. */
const PARTIAL_FRENCH = {
    commands: { livck: { description: 'Gérer les pages de statut LIVCK' } },
    messages: { status: { title: 'Services de :name' } },
};

beforeAll(() => {
    translation.translations.fr = PARTIAL_FRENCH;
});

afterAll(() => {
    delete translation.translations.fr;
    translation.setLocale('de');
});

describe('a language that is only half translated', () => {
    test('is accepted rather than silently replaced', () => {
        translation.setLocale('fr');
        expect(translation.locale).toBe('fr');
    });

    test('uses its own string where it has one', () => {
        expect(translation.trans('messages.status.title', { name: 'X' }, null, 'fr'))
            .toBe('Services de X');
    });

    test('falls back to English for every key it lacks — all of them', () => {
        // The whole point: not one key may render as itself.
        const leaked = ALL_KEYS.filter((key) => translation.trans(key, {}, null, 'fr') === key);

        expect(leaked).toEqual([]);
    });

    test('the keys this branch added are covered too', () => {
        // These exist in no community translation yet, by definition.
        for (const key of [
            'messages.pause.footer',
            'messages.pause.reason.NOT_JSON',
            'commands.livck.subscribe.unreachable',
            'commands.livck.custom_links.more_links',
        ]) {
            const text = translation.trans(key, { reason: 'x', url: 'y', count: 1 }, null, 'fr');

            expect(text).not.toBe(key);
            expect(text.length).toBeGreaterThan(0);
        }
    });

    test('placeholders are still filled in a fallen-back string', () => {
        // A fallback that returns the English sentence but leaves `:url` in it would be worse
        // than the key.
        const text = translation.trans('commands.livck.subscribe.unreachable', {
            url: 'https://status.example.com', reason: 'DNS',
        }, null, 'fr');

        expect(text).toContain('https://status.example.com');
        expect(text).not.toContain(':url');
        expect(text).not.toContain(':reason');
    });

    test('a language nobody has touched at all still renders English', () => {
        const leaked = ALL_KEYS.filter((key) => translation.trans(key, {}, null, 'kl') === key);

        expect(leaked).toEqual([]);
    });
});

describe('the two languages that ship complete', () => {
    test.each([['de', de], ['en', en]])('%s has every key the other has', (_locale, source) => {
        expect(flatten(source).sort()).toEqual(ALL_KEYS.slice().sort());
    });

    test('no key resolves to an empty string in either', () => {
        // An empty translation is invisible in Discord and reads as a rendering bug.
        for (const locale of ['de', 'en']) {
            for (const key of ALL_KEYS) {
                expect(String(translation.trans(key, {}, null, locale)).trim().length).toBeGreaterThan(0);
            }
        }
    });
});
