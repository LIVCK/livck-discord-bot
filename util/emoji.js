/**
 * What Discord accepts as a button emoji, and nothing else.
 *
 * A custom link's emoji is free text from a modal. Discord takes exactly two shapes for a button:
 * one Unicode emoji, or a custom one written `<:name:id>` / `<a:name:id>`. Anything else — a
 * shortcode like `:zap:`, a word, two emojis, an emoji with text after it — is rejected with
 * 50035 COMPONENT_INVALID_EMOJI, and Discord rejects the WHOLE message for it. One bad emoji on
 * one link therefore stopped that channel's status message from ever updating again, retried
 * every few seconds for as long as the link existed.
 */

const CUSTOM = /^<(a?):([\w~]{2,32}):(\d{17,20})>$/;

// One emoji: a pictograph (with any modifiers, joiners and variation selectors that make it one
// grapheme), a flag of two regional indicators, or a keycap like 1️⃣.
const UNICODE_START = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]️?⃣)/u;

const graphemes = (text) => [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].length;

/**
 * @param {string|null|undefined} input
 * @returns {{id: string, name: string, animated: boolean}|{name: string}|null} for
 *   ButtonBuilder#setEmoji, or null when Discord would not take it
 */
export const parseButtonEmoji = (input) => {
    const text = String(input ?? '').trim();
    if (!text) return null;

    const custom = text.match(CUSTOM);
    if (custom) return { id: custom[3], name: custom[2], animated: custom[1] === 'a' };

    if (graphemes(text) === 1 && UNICODE_START.test(text)) return { name: text };

    return null;
};

/** The emoji as it should be stored: trimmed, or null when there is none to keep. */
export const normalizeButtonEmoji = (input) => (parseButtonEmoji(input) ? String(input).trim() : null);

export default { parseButtonEmoji, normalizeButtonEmoji };
