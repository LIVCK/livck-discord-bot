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
 * The channel is gone for good — deleted. The subscription can never be delivered again, so
 * the handlers drop it.
 *
 * Deliberately NOT in here:
 * - 50013 (Missing Permissions): the bot may look but not post. A server setting an admin can
 *   fix in seconds, and deleting the subscription over it would be unrecoverable.
 * - 50001 (Missing Access): the bot can no longer see the channel. Just as often a setting —
 *   a category made private, a role edited, the bot's role removed for an afternoon — and the
 *   channel is still there. It used to delete the subscription, so one careless permission
 *   change cost a guild its whole setup. It backs off instead, on a ladder of its own (see
 *   util/delivery.js).
 */
export const isChannelGone = (error) => error?.code === UNKNOWN_CHANNEL;

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

/**
 * A message that reached Discord although the answer did not.
 *
 * A POST can arrive and its answer get lost: a network blip on the way back, or Discord itself
 * answering slower than the client's 15 seconds. @discordjs/rest then sends the same POST again,
 * up to three times, and after that the delivery's backoff tries once more on a later cycle.
 * Every one of them was a new message. Measured against the real API with the answers dropped
 * on the way back: one incident, six copies in the channel, one of them recorded.
 *
 * Discord's answer is a nonce with `enforce_nonce`: the same nonce from the same bot within a
 * few minutes returns the message it already made instead of making another. So each message
 * keeps ONE nonce from its first attempt until its row is written — across the library's
 * retries and the backoff's — and only then is it forgotten, so a message an admin deleted is
 * posted again with a fresh one.
 *
 * Held in memory: a restart in the middle of it costs at worst the duplicate it would always
 * have cost.
 */
const pendingNonces = new Map();
const MAX_PENDING_NONCES = 10_000;

const nonceFor = (create) => {
    const key = `${create.subscriptionId}:${create.category}:${create.serviceId ?? ''}`;
    let nonce = pendingNonces.get(key);
    if (!nonce) {
        if (pendingNonces.size >= MAX_PENDING_NONCES) pendingNonces.delete(pendingNonces.keys().next().value);
        // At most 25 characters, which Discord allows for a nonce.
        nonce = crypto.randomBytes(15).toString('base64url');
        pendingNonces.set(key, nonce);
    }
    return { key, nonce };
};

/** For tests. */
export const clearPendingNonces = () => pendingNonces.clear();

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
        const { key, nonce } = nonceFor(create);
        const once = { ...payload, nonce, enforceNonce: true };
        const sent = await (send ? send(once, resolved) : resolved.send(once));
        try {
            await models.Message.create({ ...create, messageId: sent.id, contentHash: hash });
            pendingNonces.delete(key);
        } catch (error) {
            pendingNonces.delete(key);
            // Discord has the message and the database does not, so nothing would ever edit
            // it, and the next cycle — finding no row — would post it a second time. Take it
            // back while the id is still known. If Discord refuses that too, the duplicate is
            // unavoidable, and the line says which message it is.
            try {
                await resolved.messages.delete(sent.id);
            } catch (deleteError) {
                logger.warn(`[MessageSync] Message ${sent.id} was posted but not recorded, and could not be taken back: ${deleteError.message}`);
            }
            throw error;
        }
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
