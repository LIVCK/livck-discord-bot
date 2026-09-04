/**
 * Sending and updating Discord messages without burning the API budget.
 *
 * TWO PROBLEMS THIS SOLVES
 *
 * 1. A wasted round trip. The handlers used to `channel.messages.fetch(id)` and then call
 *    `.edit()` on the result — two REST calls where one does the job. `channel.messages.edit(id, …)`
 *    issues a single PATCH and needs no cached Message.
 *
 * 2. Editing a message that did not change. The status embed is re-rendered every cycle and
 *    edited unconditionally, so a page that has been green for a week still costs one edit
 *    per subscription per cycle. Discord allows a bot 50 requests per second in total, which
 *    put the ceiling near 375 subscriptions on the 15s loop. Hashing the payload and editing
 *    only on a real change removes essentially all of that traffic.
 *
 * WHY THE TIMESTAMP IS EXCLUDED FROM THE HASH
 *
 * Every layout calls `.setTimestamp(new Date())`, so including it would make each render
 * differ and the check would never fire. Leaving it out changes what the timestamp means:
 * "as of the last change" rather than "as of the last poll". That is the more useful reading,
 * but a message that never updates also stops looking alive — so a heartbeat edit runs at
 * most every STATUS_REFRESH_MINUTES to refresh it.
 */

import crypto from 'crypto';
import logger from './logger.js';

/** How long a status message may go untouched before it is refreshed anyway. */
const REFRESH_MINUTES = Number(process.env.STATUS_REFRESH_MINUTES || 15);
const REFRESH_MS = Math.max(1, REFRESH_MINUTES) * 60 * 1000;

/** Discord: unknown message — it was deleted in the channel. */
export const UNKNOWN_MESSAGE = 10008;
/** Discord: unknown channel. */
export const UNKNOWN_CHANNEL = 10003;
/** Discord: missing access to the channel. */
export const MISSING_ACCESS = 50001;

/**
 * Stable fingerprint of what would be sent to Discord.
 *
 * Builders are serialized through `toJSON()` so two structurally identical payloads hash
 * alike, and `timestamp` is dropped for the reason above.
 *
 * @param {{embeds?: any[], components?: any[], content?: string}} payload
 * @returns {string} hex sha256
 */
export const hashPayload = ({ embeds = [], components = [], content = '' } = {}) => {
    const serialize = (item) => (item && typeof item.toJSON === 'function' ? item.toJSON() : item);

    const embedParts = embeds.map((embed) => {
        const json = { ...serialize(embed) };
        delete json.timestamp;
        return json;
    });

    const shape = {
        content: content || '',
        embeds: embedParts,
        components: components.map(serialize),
    };

    return crypto.createHash('sha256').update(JSON.stringify(shape)).digest('hex');
};

/** True when the stored message is older than the heartbeat interval. */
const needsHeartbeat = (record, now) => {
    const last = record.updatedAt ? new Date(record.updatedAt).getTime() : 0;
    return now - last >= REFRESH_MS;
};

/**
 * Create or update the Discord message tracked by a `Message` row.
 *
 * @param {object} options
 * @param {import('discord.js').TextBasedChannel} options.channel
 * @param {object|null} options.record - the Message model row, or null to create one
 * @param {object} options.payload - `{embeds, components, content}` for Discord
 * @param {object} options.models
 * @param {object} options.create - fields for a new Message row (subscriptionId, category, …)
 * @param {boolean} [options.heartbeat] - refresh periodically even when unchanged
 * @param {(payload: object) => Promise<import('discord.js').Message>} [options.send]
 *   How to post a NEW message. Defaults to `channel.send`; alert updates pass a variant that
 *   attaches `reply.messageReference` so the update threads under its parent — by ID, so no
 *   fetch of the parent message is needed.
 * @returns {Promise<'created'|'updated'|'skipped'|'recreate'>}
 */
export const syncMessage = async ({
    channel,
    record,
    payload,
    models,
    create,
    heartbeat = false,
    send = null,
}) => {
    const hash = hashPayload(payload);

    if (!record) {
        const sent = await (send ? send(payload) : channel.send(payload));
        await models.Message.create({ ...create, messageId: sent.id, contentHash: hash });
        return 'created';
    }

    const unchanged = record.contentHash === hash;
    const stale = heartbeat && needsHeartbeat(record, Date.now());

    if (unchanged && !stale) {
        return 'skipped';
    }

    try {
        // One PATCH. No preceding fetch — the message ID is all Discord needs.
        await channel.messages.edit(record.messageId, payload);
        await record.update({ contentHash: hash });
        return 'updated';
    } catch (error) {
        if (error.code === UNKNOWN_MESSAGE) {
            // Someone deleted it in Discord; drop the row so the next cycle posts a new one.
            await record.destroy();
            logger.debug(`[MessageSync] Message ${record.messageId} is gone, will repost`);
            return 'recreate';
        }
        throw error;
    }
};

export default { hashPayload, syncMessage, UNKNOWN_MESSAGE, UNKNOWN_CHANNEL, MISSING_ACCESS };
