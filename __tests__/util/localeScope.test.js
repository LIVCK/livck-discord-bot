/**
 * The language must belong to the flow that asked for it.
 *
 * `setLocale()` wrote to a field on a module singleton, and every caller sets a language and
 * then AWAITS before rendering — a database read, a fetch, a Discord call. The update loop
 * runs 100 status pages at a time and both handlers concurrently per page, so whichever
 * subscription resumed last decided the language for all of them.
 *
 * In production that is a German channel receiving an English incident thread. And because
 * the interleaving differs from one cycle to the next, the content hash flips with it and the
 * message is edited back and forth for ever — a wrong-language flap that also spends the
 * Discord budget the content hash exists to protect.
 */

import translation, { withLocale } from '../../util/Translation.js';

/** A render that awaits before it renders, which is every real one. */
const renderAfterAwait = async (locale) => {
    translation.setLocale(locale);
    await new Promise((resolve) => setImmediate(resolve));
    return translation.trans('messages.status.title', { name: 'X' });
};

describe('two languages rendered at the same time', () => {
    test('without a scope they collide — the defect this pins shut', async () => {
        const [de, en] = await Promise.all([renderAfterAwait('de'), renderAfterAwait('en')]);

        // Documented, not endorsed: this is what every caller used to do.
        expect(de).toBe(en);
    });

    test('inside their own scopes each keeps its own language', async () => {
        const [de, en] = await Promise.all([
            withLocale('de', () => renderAfterAwait('de')),
            withLocale('en', () => renderAfterAwait('en')),
        ]);

        expect(de).not.toBe(en);
        expect(de).toBe(translation.trans('messages.status.title', { name: 'X' }, null, 'de'));
        expect(en).toBe(translation.trans('messages.status.title', { name: 'X' }, null, 'en'));
    });

    test('a scope survives several awaits, not just the first', async () => {
        const deep = async (locale) => withLocale(locale, async () => {
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setTimeout(resolve, 5));
            await Promise.resolve();
            return translation.trans('messages.status.title', { name: 'X' });
        });

        const [de, en] = await Promise.all([deep('de'), deep('en')]);
        expect(de).not.toBe(en);
    });

    test('ten flows interleaved still each get what they asked for', async () => {
        const wanted = ['de', 'en', 'de', 'en', 'de', 'en', 'de', 'en', 'de', 'en'];

        const results = await Promise.all(wanted.map((locale) =>
            withLocale(locale, async () => {
                await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));
                return { locale, text: translation.trans('messages.status.title', { name: 'X' }) };
            })
        ));

        for (const { locale, text } of results) {
            expect(text).toBe(translation.trans('messages.status.title', { name: 'X' }, null, locale));
        }
    });
});

describe('outside any scope', () => {
    test('setLocale still behaves exactly as before', () => {
        // Anything that never opens a scope must be unaffected by this change.
        translation.setLocale('de');
        const de = translation.trans('messages.status.title', { name: 'X' });

        translation.setLocale('en');
        const en = translation.trans('messages.status.title', { name: 'X' });

        expect(de).not.toBe(en);
    });

    test('a scope does not leak its language back out', () => {
        translation.setLocale('de');
        const before = translation.trans('messages.status.title', { name: 'X' });

        withLocale('en', () => translation.trans('messages.status.title', { name: 'X' }));

        expect(translation.trans('messages.status.title', { name: 'X' })).toBe(before);
    });

    test('an unknown language still falls back rather than throwing', () => {
        expect(() => withLocale('kl', () => translation.trans('messages.status.title', { name: 'X' })))
            .not.toThrow();
    });
});
