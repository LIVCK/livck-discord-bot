/**
 * Cutting a Markdown body without breaking what is inside it.
 *
 * Found in a live channel: a maintenance announcement arrived ending
 * `…bleiben davon **unberührt und weiterhin online...` — the bold opener never closed, because
 * the cut was a plain `substring` and Markdown is stateful. Discord then renders the rest as
 * literal asterisks or drops the emphasis, and an unclosed code fence is worse: everything
 * after it becomes one code block.
 *
 * The rule is CLOSE, do not strip. The author meant that passage to be emphasised; dropping
 * the marker throws away an intention, closing it keeps one. The exception is an opener with
 * nothing left after it, which would only wrap the ellipsis in empty emphasis.
 */

import { truncateMarkdown } from '../../util/markdown.js';

/** Markers Discord treats as paired. An odd count is a broken message. */
const unbalanced = (text) => Object.entries({
    '```': /```/g,
    '**': /\*\*/g,
    '__': /__/g,
    '~~': /~~/g,
}).filter(([, pattern]) => ((text.match(pattern) || []).length % 2) === 1).map(([marker]) => marker);

describe('a body that fits', () => {
    test('is returned untouched, with no ellipsis', () => {
        expect(truncateMarkdown('Kurzer Text.', 500)).toBe('Kurzer Text.');
    });

    test('is untouched at exactly the limit', () => {
        const text = 'x'.repeat(100);
        expect(truncateMarkdown(text, 100)).toBe(text);
    });
});

describe('a body that has to be cut', () => {
    test('closes an open bold rather than leaving it dangling', () => {
        // The exact shape seen in production.
        const source = 'Alle Produkte bleiben davon **unberührt und weiterhin online, wir melden uns';
        const out = truncateMarkdown(source, 60);

        expect(unbalanced(out)).toEqual([]);
        expect(out).toMatch(/\*\*unberührt[^*]*\*\*…$/);
    });

    test('drops an opener that has nothing after it', () => {
        // Closing it would wrap the ellipsis in empty emphasis.
        const out = truncateMarkdown('Text und dann direkt am Ende ein **', 33);

        expect(out).not.toContain('**');
        expect(out.endsWith('…')).toBe(true);
    });

    test('closes a code fence, which would otherwise swallow the whole message', () => {
        const out = truncateMarkdown('Beispiel:\n```\nsystemctl restart nginx\nund weiter', 30);

        expect(unbalanced(out)).toEqual([]);
        expect(out).toContain('```');
    });

    test('never ends inside a link', () => {
        // Half of `[text](url)` is not a link, it is noise.
        const out = truncateMarkdown('Mehr dazu in [unserem Bericht](https://status.example.com/x)', 40);

        expect(out).not.toMatch(/\[[^\]]*$/);
        expect(out).not.toMatch(/\]\([^)]*$/);
    });

    test('closes italics and strikethrough too', () => {
        expect(unbalanced(truncateMarkdown('Das ist *wichtig für alle Kunden', 25))).toEqual([]);
        expect(unbalanced(truncateMarkdown('Das ist ~~alt und überholt für alle~~ ~~noch', 30))).toEqual([]);
    });

    test('cuts at a word boundary rather than mid-word', () => {
        // The kept text must be a prefix of the source that ends where a word ends — not
        // "Wartungsarb…".
        const source = 'Wartungsarbeiten an der Webseite werden durchgeführt';
        const kept = truncateMarkdown(source, 30).replace('…', '');

        expect(source.startsWith(kept)).toBe(true);
        const next = source.charAt(kept.length);
        expect(next === '' || next === ' ').toBe(true);
    });

    test('stays within the limit it was given', () => {
        for (const max of [20, 50, 120, 500]) {
            const out = truncateMarkdown('**Wartung** an der `Webseite` — mehr dazu [hier](https://x.example) und noch viel mehr Text danach der weiterläuft', max);
            expect(out.length).toBeLessThanOrEqual(max + 4); // the closers it had to add
        }
    });
});

describe('whatever it is handed', () => {
    test.each([
        ['**' .repeat(40), 30],
        ['```' .repeat(20), 25],
        ['[' .repeat(50), 20],
        ['~~*__`' .repeat(30), 40],
    ])('leaves nothing unbalanced (%#)', (source, max) => {
        // Adversarial input still has to produce a message Discord can render.
        expect(unbalanced(truncateMarkdown(source, max))).toEqual([]);
    });

    test('a non-string is passed through rather than crashing a whole cycle', () => {
        expect(truncateMarkdown(null, 10)).toBeNull();
        expect(truncateMarkdown(undefined, 10)).toBeUndefined();
    });
});
