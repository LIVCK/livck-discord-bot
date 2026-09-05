/**
 * Formatting that a rich-text editor actually emits.
 *
 * Every inline rule matched only the bare tag, with no `s` flag. So anything carrying a class
 * or a style — which is most of what a WYSIWYG editor produces — and any inline element
 * wrapping a line break missed every rule and fell through to the generic stripper, arriving
 * in Discord as plain text. The customer wrote bold; the reader got nothing.
 */

import { htmlToDiscord } from '../../util/markdown.js';

describe('inline formatting with attributes', () => {
    test.each([
        ['<strong>fett</strong>', '**fett**'],
        ['<strong class="lead">fett</strong>', '**fett**'],
        ['<em style="color:red">kursiv</em>', '*kursiv*'],
        ['<b data-x="1">fett</b>', '**fett**'],
        ['<code class="lang-js">x</code>', '`x`'],
        ['<u title="t">unter</u>', '__unter__'],
        ['<del class="x">weg</del>', '~~weg~~'],
    ])('%s', (input, expected) => {
        expect(htmlToDiscord(input).trim()).toBe(expected);
    });

    test('an inline element may wrap a line break', () => {
        expect(htmlToDiscord('<strong>über\nzwei Zeilen</strong>').trim()).toBe('**über\nzwei Zeilen**');
    });

    test('a heading with attributes is still a heading', () => {
        expect(htmlToDiscord('<h2 id="x">Titel</h2>').trim()).toBe('**Titel**');
    });

    test('a paragraph with attributes still breaks the line', () => {
        expect(htmlToDiscord('<p class="a">eins</p><p>zwei</p>').trim()).toBe('eins\n\nzwei');
    });

    test('a list item with attributes keeps its bullet', () => {
        expect(htmlToDiscord('<ul><li class="x">eins</li><li>zwei</li></ul>').trim())
            .toBe('• eins\n• zwei');
    });
});
