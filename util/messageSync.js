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
 * The channel is gone for good as far as this bot is concerned — deleted, or no longer
 * visible to it. The subscription can never be delivered again, so the handlers drop it.
 *
 * Deliberately NOT in here: 50013 (Missing Permissions), which is what a channel where the
 * bot may look but not post returns. That is a server setting an admin can fix in seconds,
 * and deleting the subscription over it would be unrecoverable.
 */
export const isChannelGone = (error) =>
    error?.code === UNKNOWN_CHANNEL || error?.code === MISSING_ACCESS;

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
 * Record that the message was just written, and make sure `updatedAt` actually moves.
 *
 * `record.update({contentHash})` looks right and is not. When the HEARTBEAT fires the content
 * is by definition unchanged, so the hash is identical, so Sequelize finds nothing dirty and
 * issues NO SQL AT ALL (`model.js`: `if (!this.changed() && !this.isNewRecord) return this;`).
 * `updatedAt` therefore never moves, the row stays past the staleness threshold, and the
 * heartbeat fires again on the very next cycle — and every cycle after that.
 *
 * The effect is the exact opposite of what this whole file exists for: a page that has been
 * green for STATUS_REFRESH_MINUTES crosses the threshold once and from then on every status
 * subscription is edited every 15 SECONDS instead of every 15 minutes, for ever. Sixty times
 * the intended traffic against a 50 requests/second budget.
 *
 * A query-level update always executes, so the timestamp always advances. (Passing an explicit
 * `updatedAt`, or naming it in `fields`, does NOT help — both still no-op.)
 */
const touch = async (models, record, hash) => {
    await models.Message.update({ contentHash: hash }, { where: { id: record.id } });

    // Keep the in-memory row consistent with what was just written, so a caller that reads
    // it back in the same cycle does not see the old values.
    record.contentHash = hash;
    record.updatedAt = new Date();
};

/**
 * Create or update the Discord message tracked by a `Message` row.
 *
 * @param {object} options
 * @param {import('discord.js').TextBasedChannel|(() => Promise<import('discord.js').TextBasedChannel|null>)} options.channel
 *   The channel, or a function returning it. A THUNK is what keeps a skipped update free: the
 *   channel is only resolved once something is actually going to be sent. discord.js serves
 *   `channels.fetch` from its gateway cache in steady state, but that cache is cold right after
 *   a restart — and resolving it eagerly would mean one REST call per subscription in the very
 *   first cycle, which is exactly when the bot can least afford them.
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

    // Decided BEFORE the channel is touched, so an unchanged message costs nothing at all.
    if (record) {
        const unchanged = record.contentHash === hash;
        const stale = heartbeat && needsHeartbeat(record, Date.now());

        if (unchanged && !stale) {
            return 'skipped';
        }
    }

    const resolved = typeof channel === 'function' ? await channel() : channel;
    if (!resolved) {
        return 'skipped';
    }

    if (!record) {
        const sent = await (send ? send(payload, resolved) : resolved.send(payload));
        await models.Message.create({ ...create, messageId: sent.id, contentHash: hash });
        return 'created';
    }

    try {
        // One PATCH. No preceding fetch — the message ID is all Discord needs.
        await resolved.messages.edit(record.messageId, payload);
        await touch(models, record, hash);
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

export default { hashPayload, syncMessage, isChannelGone, UNKNOWN_MESSAGE, UNKNOWN_CHANNEL, MISSING_ACCESS };
