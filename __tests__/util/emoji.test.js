/**
 * util/emoji.js: what Discord takes as a button emoji. One it does not take gets the whole
 * message rejected, so this decides whether a channel's status message can be sent at all.
 */

import { parseButtonEmoji, normalizeButtonEmoji } from '../../util/emoji.js';

describe('accepted', () => {
    test.each([
        ['🔗', { name: '🔗' }],
        ['❤️', { name: '❤️' }],
        ['👍🏽', { name: '👍🏽' }],
        ['👨‍👩‍👧', { name: '👨‍👩‍👧' }],
        ['🇩🇪', { name: '🇩🇪' }],
        ['1️⃣', { name: '1️⃣' }],
        ['  🌐  ', { name: '🌐' }],
        ['<:livck:1300000000000000123>', { id: '1300000000000000123', name: 'livck', animated: false }],
        ['<a:spin:1300000000000000123>', { id: '1300000000000000123', name: 'spin', animated: true }],
    ])('%s', (input, expected) => {
        expect(parseButtonEmoji(input)).toEqual(expected);
    });
});

describe('refused', () => {
    test.each([':zap:', 'Status', '🔗🔗', '🔗 Doku', 'Doku 🔗', '<:livck>', '<:livck:123>', '<livck:1300000000000000123>', '#', '', '   ', null, undefined])('%p', (input) => {
        expect(parseButtonEmoji(input)).toBeNull();
    });
});

test('stored trimmed, or not at all', () => {
    expect(normalizeButtonEmoji(' 🔗 ')).toBe('🔗');
    expect(normalizeButtonEmoji(':zap:')).toBeNull();
    expect(normalizeButtonEmoji('')).toBeNull();
});
