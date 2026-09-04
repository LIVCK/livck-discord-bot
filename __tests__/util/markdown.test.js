import { bodyToDiscord, htmlToDiscord, markdownToDiscord } from '../../util/markdown.js';

describe('htmlToDiscord', () => {
    test('converts inline formatting', () => {
        expect(htmlToDiscord('<strong>bold</strong>')).toBe('**bold**');
        expect(htmlToDiscord('<em>italic</em>')).toBe('*italic*');
        expect(htmlToDiscord('<del>gone</del>')).toBe('~~gone~~');
        expect(htmlToDiscord('<code>x = 1</code>')).toBe('`x = 1`');
    });

    test('turns links into Discord masked links', () => {
        expect(htmlToDiscord('<a href="https://x.test">Docs</a>')).toBe('[Docs](https://x.test)');
    });

    test('turns list items into bullets', () => {
        expect(htmlToDiscord('<ul><li>one</li><li>two</li></ul>')).toContain('• one');
        expect(htmlToDiscord('<ul><li>one</li><li>two</li></ul>')).toContain('• two');
    });

    test('decodes entities', () => {
        expect(htmlToDiscord('<p>A &amp; B &quot;C&quot;</p>')).toBe('A & B "C"');
    });

    test('strips tags it does not know rather than printing them', () => {
        expect(htmlToDiscord('<section><span>text</span></section>')).toBe('text');
    });

    test('handles a real self-hosted alert body', () => {
        // Recorded from fc-status.net.
        const html = '<p>Aufgrund einer Störung unseres Upstream Anbieters ist die Hotline gerade nicht erreichbar.</p><p>Bitte Kontaktieren Sie uns übers Ticketsystem oder per Email.</p>';
        const result = htmlToDiscord(html);

        expect(result).toContain('Hotline gerade nicht erreichbar');
        expect(result).not.toContain('<p>');
    });

    test('empty input yields an empty string', () => {
        expect(htmlToDiscord('')).toBe('');
        expect(htmlToDiscord(null)).toBe('');
        expect(htmlToDiscord(undefined)).toBe('');
    });
});

describe('markdownToDiscord', () => {
    test('leaves what Discord already understands untouched', () => {
        // The whole point of the Cloud path being cheap: Discord speaks this dialect.
        const input = '**bold** and *italic* and `code` and [a link](https://x.test)';
        expect(markdownToDiscord(input)).toBe(input);
    });

    test('keeps headings, quotes and lists', () => {
        const input = '## Heading\n\n> quoted\n\n- one\n- two';
        expect(markdownToDiscord(input)).toBe(input);
    });

    test('keeps fenced code blocks intact', () => {
        const input = '```js\nconst x = 1;\n```';
        expect(markdownToDiscord(input)).toBe(input);
    });

    test('turns an image into a link, since Discord shows none inline', () => {
        expect(markdownToDiscord('![Diagram](https://x.test/i.png)'))
            .toBe('[Diagram](https://x.test/i.png)');
    });

    test('an image without alt text degrades to the bare url', () => {
        expect(markdownToDiscord('![](https://x.test/i.png)')).toBe('https://x.test/i.png');
    });

    test('a table becomes readable lines instead of a wall of pipes', () => {
        // Discord has no table syntax at all.
        const result = markdownToDiscord('| Node | Status |\n| --- | --- |\n| a | up |\n| b | down |');

        expect(result).not.toContain('|');
        expect(result).toContain('Node · Status');
        expect(result).toContain('a · up');
    });

    test('drops horizontal rules, which render as an empty gap', () => {
        expect(markdownToDiscord('before\n\n---\n\nafter')).toBe('before\n\nafter');
    });

    test('strips raw HTML that leaked into the markdown', () => {
        expect(markdownToDiscord('text <span class="x">inside</span> more')).toBe('text inside more');
    });

    test('does not gut a code block that contains tags', () => {
        // The fences are protected before the HTML strip, or a snippet would be mangled.
        const input = '```html\n<div class="x">hi</div>\n```';
        expect(markdownToDiscord(input)).toBe(input);
    });

    test('handles a real Cloud incident body', () => {
        // Recorded from status.emeraldhost.de.
        const input = 'Wir untersuchen derzeit eine Störung an `er1.cgn1.as200482.net`, die sich auf das Netzwerk in CGN1 ausbreitet.';
        expect(markdownToDiscord(input)).toBe(input);
    });

    test('handles a real Cloud maintenance body with a list', () => {
        const input = 'Wir führen geplante Wartungsarbeiten durch. Betroffen sind folgende Nodes:\n\n- game3.fsn1.emeraldhost.de\n- game43.egh1.emeraldhost.de';
        expect(markdownToDiscord(input)).toBe(input);
    });

    test('collapses the blank lines its removals leave behind', () => {
        expect(markdownToDiscord('a\n\n\n\n\nb')).toBe('a\n\nb');
    });

    test('empty input yields an empty string', () => {
        expect(markdownToDiscord('')).toBe('');
        expect(markdownToDiscord(null)).toBe('');
    });
});

describe('bodyToDiscord', () => {
    test('routes by the format the source declares', () => {
        expect(bodyToDiscord('<strong>x</strong>', 'html')).toBe('**x**');
        expect(bodyToDiscord('**x**', 'markdown')).toBe('**x**');
    });

    test('an unknown format is treated as HTML, the older of the two', () => {
        expect(bodyToDiscord('<strong>x</strong>', undefined)).toBe('**x**');
    });
});
