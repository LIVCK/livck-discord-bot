/**
 * Discord embed limits and the helpers that keep us inside them.
 *
 * Discord rejects an over-limit message with HTTP 400 and drops the WHOLE message — not
 * the offending field. A status page with many services therefore posts nothing at all,
 * which is the worst possible failure mode for a status bot. Every layout runs its output
 * through here before it reaches the API.
 *
 * Values from the official API documentation (developers/resources/message):
 *   - up to 10 embeds per message, 6000 characters across ALL of them combined
 *   - max 25 fields per embed
 *   - title / field name / author name: 256, description: 4096, field value: 1024,
 *     footer text: 2048, message content: 2000
 *
 * Note also that Discord trims leading and trailing whitespace, which is why indentation
 * in the layouts uses box-drawing characters rather than spaces.
 */

export const DISCORD_LIMITS = {
    EMBED_TITLE: 256,
    EMBED_DESCRIPTION: 4096,
    EMBED_FIELDS: 25,
    EMBED_FIELD_NAME: 256,
    EMBED_FIELD_VALUE: 1024,
    EMBED_FOOTER_TEXT: 2048,
    EMBED_AUTHOR_NAME: 256,
    /** Combined across every embed of one message. */
    MESSAGE_EMBED_TOTAL: 6000,
    EMBEDS_PER_MESSAGE: 10,
    MESSAGE_CONTENT: 2000,
};

const ELLIPSIS = '…';

/**
 * Hard-truncate to `max` characters, marking the cut.
 * Returns '' for nullish input so callers can pass optional values straight through.
 */
export const truncate = (text, max) => {
    if (text === null || text === undefined) return '';
    const value = String(text);
    if (value.length <= max) return value;
    if (max <= ELLIPSIS.length) return value.slice(0, max);
    return value.slice(0, max - ELLIPSIS.length) + ELLIPSIS;
};

/**
 * Join lines into a field value (or description), dropping the tail that does not fit and
 * replacing it with a "+N more" line.
 *
 * Dropping whole lines rather than cutting mid-line matters: a truncated service name reads
 * like a broken service name.
 *
 * @param {string[]} lines
 * @param {object} options
 * @param {number} options.max - character budget for the joined result
 * @param {(count: number) => string} [options.more] - builds the overflow line
 * @param {string} [options.separator]
 * @returns {string}
 */
export const joinWithinLimit = (lines, { max, more = null, separator = '\n' } = {}) => {
    const items = (lines || []).filter((line) => line !== null && line !== undefined && line !== '');
    if (items.length === 0) return '';

    const joined = items.join(separator);
    if (joined.length <= max) return joined;

    // Grow from the front, always leaving room for the overflow line we will need.
    const kept = [];
    let length = 0;

    for (let i = 0; i < items.length; i += 1) {
        const remaining = items.length - i;
        const overflowLine = more ? more(remaining) : null;
        const overflowCost = overflowLine ? overflowLine.length + separator.length : 0;
        const cost = (kept.length === 0 ? 0 : separator.length) + items[i].length;

        if (length + cost + overflowCost > max) break;

        kept.push(items[i]);
        length += cost;
    }

    const dropped = items.length - kept.length;
    if (dropped === 0) return kept.join(separator);

    const overflowLine = more ? more(dropped) : null;
    if (!overflowLine) return truncate(kept.join(separator), max);

    if (kept.length === 0) return truncate(overflowLine, max);
    return truncate([...kept, overflowLine].join(separator), max);
};

/**
 * Clamp an embed's field list to Discord's maximum, folding the remainder into a final
 * "+N more" field. Each field's name and value are clamped too.
 *
 * @param {Array<{name: string, value: string, inline?: boolean}>} fields
 * @param {object} options
 * @param {number} [options.max]
 * @param {(count: number) => {name: string, value: string, inline?: boolean}} [options.more]
 */
export const capFields = (fields, { max = DISCORD_LIMITS.EMBED_FIELDS, more = null } = {}) => {
    const list = (fields || []).map((field) => ({
        ...field,
        name: truncate(field.name, DISCORD_LIMITS.EMBED_FIELD_NAME),
        value: truncate(field.value, DISCORD_LIMITS.EMBED_FIELD_VALUE),
    }));

    if (list.length <= max) return list;
    if (!more) return list.slice(0, max);

    const kept = list.slice(0, max - 1);
    const overflow = more(list.length - kept.length);

    return [...kept, {
        ...overflow,
        name: truncate(overflow.name, DISCORD_LIMITS.EMBED_FIELD_NAME),
        value: truncate(overflow.value, DISCORD_LIMITS.EMBED_FIELD_VALUE),
    }];
};

/**
 * Pad an inline field list so the last row is full, WITHOUT crossing `max`.
 *
 * The compact and overview layouts lay fields out three per row and pad the remainder with
 * zero-width fields. Padding after a cap could push the count past 25, so the pad is only
 * applied when it still fits.
 */
export const padInlineRows = (fields, { perRow = 3, max = DISCORD_LIMITS.EMBED_FIELDS } = {}) => {
    const remainder = fields.length % perRow;
    if (remainder === 0) return fields;

    const needed = perRow - remainder;
    if (fields.length + needed > max) return fields;

    const padded = [...fields];
    for (let i = 0; i < needed; i += 1) {
        padded.push({ name: '​', value: '​', inline: true });
    }
    return padded;
};

/** Character cost Discord counts for one embed. */
export const embedLength = (embedJson) => {
    if (!embedJson) return 0;
    let total = 0;
    total += (embedJson.title || '').length;
    total += (embedJson.description || '').length;
    total += (embedJson.footer?.text || '').length;
    total += (embedJson.author?.name || '').length;
    for (const field of embedJson.fields || []) {
        total += (field.name || '').length + (field.value || '').length;
    }
    return total;
};

/**
 * Last line of defence: bring a message's embeds under the combined 6000-character budget
 * and the 10-embed cap.
 *
 * Trims from the end — the tail of a status list is the least important part — by dropping
 * trailing fields first, then truncating the description. Mutates the builders in place and
 * returns them, so callers can keep using EmbedBuilder instances.
 *
 * @param {import('discord.js').EmbedBuilder[]} embeds
 * @param {(count: number) => {name: string, value: string, inline?: boolean}} [more]
 */
export const enforceMessageBudget = (embeds, more = null) => {
    const list = (embeds || []).slice(0, DISCORD_LIMITS.EMBEDS_PER_MESSAGE);

    const total = () => list.reduce((sum, embed) => sum + embedLength(embed.toJSON()), 0);
    if (total() <= DISCORD_LIMITS.MESSAGE_EMBED_TOTAL) return list;

    for (let i = list.length - 1; i >= 0 && total() > DISCORD_LIMITS.MESSAGE_EMBED_TOTAL; i -= 1) {
        const embed = list[i];
        let json = embed.toJSON();
        let dropped = 0;

        while ((json.fields?.length || 0) > 0 && total() > DISCORD_LIMITS.MESSAGE_EMBED_TOTAL) {
            const fields = json.fields.slice(0, -1);
            dropped += 1;
            embed.setFields(fields);
            json = embed.toJSON();
        }

        if (dropped > 0 && more) {
            // Re-add the marker only when it does not itself blow the budget.
            const marker = more(dropped);
            const cost = marker.name.length + marker.value.length;
            if (total() + cost <= DISCORD_LIMITS.MESSAGE_EMBED_TOTAL) {
                embed.addFields(marker);
            }
        }

        json = embed.toJSON();
        if (total() > DISCORD_LIMITS.MESSAGE_EMBED_TOTAL && json.description) {
            const excess = total() - DISCORD_LIMITS.MESSAGE_EMBED_TOTAL;
            embed.setDescription(truncate(json.description, Math.max(0, json.description.length - excess)) || null);
        }
    }

    return list;
};

export default DISCORD_LIMITS;
