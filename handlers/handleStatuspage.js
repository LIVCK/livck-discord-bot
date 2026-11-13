import models from '../models/index.js'
import { getLayoutRenderer } from '../messages/layoutRenderers.js'
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js'
import { fetchSnapshot } from '../providers/index.js'
import logger from '../util/logger.js'
import { groupSubscriptions } from '../util/subscriptionGroups.js'
import { syncMessage, isChannelGone } from '../util/messageSync.js'
import { parseButtonEmoji } from '../util/emoji.js'
import { claimReap } from '../util/subscriptionReaper.js'
import { withLocale } from '../util/Translation.js'
import { withPageLock } from '../util/pageLock.js'
import { deliver, forEachLimited, DELIVERY_CONCURRENCY, logDeliveryFailure, logDeliverySuccess } from '../util/delivery.js'

/** Discord allows 5 buttons per row and 5 rows. */
const MAX_BUTTONS = 25
const BUTTONS_PER_ROW = 5

/**
 * Build the link buttons under a status message.
 *
 * A Discord shortcode like `:zap:` is not a valid button emoji — only a Unicode character or
 * a custom `<:name:id>` reference is — so shortcodes are dropped rather than rejected by the
 * API along with the whole message.
 */
const buildLinkButtons = (customLinks, { withEmojis = true } = {}) => {
    if (customLinks.length === 0) return []

    const rows = []
    let current = []

    for (const link of customLinks.slice(0, MAX_BUTTONS)) {
        const button = new ButtonBuilder()
            .setLabel(link.label)
            .setURL(link.url)
            .setStyle(ButtonStyle.Link)

        // Only what Discord accepts: one bad emoji gets the whole message rejected. See util/emoji.js.
        const emoji = withEmojis ? parseButtonEmoji(link.emoji) : null
        if (emoji) button.setEmoji(emoji)

        current.push(button)

        if (current.length === BUTTONS_PER_ROW) {
            rows.push(new ActionRowBuilder().addComponents(current))
            current = []
        }
    }

    if (current.length > 0) {
        rows.push(new ActionRowBuilder().addComponents(current))
    }

    return rows
}

/**
 * Render and deliver the status message for one subscription.
 * @returns {Promise<'created'|'updated'|'skipped'|'recreate'|'ignored'>}
 */
const deliverStatus = async (subscription, snapshot, client) => {
    if (!subscription.eventTypes.STATUS) return 'ignored'

    const renderer = getLayoutRenderer(subscription.layout || 'DETAILED')
    const embeds = renderer(snapshot, subscription.locale).map((r) => r.embed)

    const customLinks = await models.CustomLink.findAll({
        where: { subscriptionId: subscription.id },
        order: [['position', 'ASC']],
    })

    const payload = { embeds, components: buildLinkButtons(customLinks) }

    // ALL of them, not the first.
    //
    // A subscription is meant to have exactly one status message, and the code that reads it
    // back has always assumed so. Before the render was serialized, two concurrent calls could
    // each find none and each post one — and from that moment the second row was invisible:
    // never edited, never removed, still showing whatever layout it was born with while the
    // first one followed every change the user made. That is what a customer sees as "the
    // extra message is not updated when I switch the layout".
    //
    // Serializing stops new ones appearing. This clears out the ones already there, in the
    // channel as well as in the database, so a bot that has been running with the bug heals
    // itself on the next cycle instead of needing someone to tidy up by hand.
    const records = await models.Message.findAll({
        where: { subscriptionId: subscription.id, category: 'STATUS' },
        order: [['id', 'ASC']],
    })

    const [record, ...duplicates] = records

    for (const extra of duplicates) {
        logger.warn(
            `[handleStatusPage] Removing a duplicate status message for subscription ${subscription.id} ` +
            `(${extra.messageId})`
        )
        try {
            const channel = await client.channels.fetch(subscription.channelId)
            await channel?.messages?.delete(extra.messageId)
        } catch (error) {
            // Already gone from the channel, or unreachable. The row goes either way.
            logger.debug(`[handleStatusPage] Could not delete ${extra.messageId}: ${error.message}`)
        }
        await extra.destroy()
    }

    const sync = (body) => syncMessage({
        // Resolved only if something is actually going to be sent — see util/messageSync.js.
        channel: () => client.channels.fetch(subscription.channelId),
        record,
        payload: body,
        models,
        create: { subscriptionId: subscription.id, category: 'STATUS' },
        // The embed timestamp is excluded from the hash, so refresh periodically to keep it
        // from looking stale on a page that has not changed in days.
        heartbeat: true,
    })

    try {
        return await sync(payload)
    } catch (error) {
        // Discord still refused an emoji the check let through (one it does not know, say).
        // The status is what matters: send it with plain buttons rather than not at all.
        if (!isRejectedEmoji(error)) throw error
        logger.once(
            `emoji:${subscription.id}`, 'warn',
            `[handleStatusPage] Discord refused a link emoji for subscription ${subscription.id}; ` +
            'sending the status without link emojis'
        )
        return sync({ embeds, components: buildLinkButtons(customLinks, { withEmojis: false }) })
    }
}

/** 50035 naming a component's emoji: the payload, not the channel, is what Discord refused. */
const isRejectedEmoji = (error) => error?.code === 50035 && /emoji/i.test(String(error?.message ?? ''))

/**
 * Serialized per page — see util/pageLock.js. `/livck` triggers an immediate refresh from
 * seven places without taking the update loop's claim, and two concurrent renders both find no
 * Message row and both post.
 */
export const handleStatusPage = (statuspageId, client) =>
    withPageLock(statuspageId, () => renderStatusPage(statuspageId, client))

const renderStatusPage = async (statuspageId, client) => {
    const statuspageRecord = await models.Statuspage.findOne({
        where: { id: statuspageId },
        include: [models.Subscription],
    })

    if (!statuspageRecord) return

    const groups = groupSubscriptions(statuspageRecord.Subscriptions)
    if (groups.length === 0) return

    let fetched = 0
    let firstError = null

    for (const { token, locale, subscriptions } of groups) {
        let snapshot

        try {
            // The provider memoizes per (page, token, locale) for a few seconds, so this and
            // handleAlerts — which run concurrently for the same page — share ONE fetch
            // instead of asking the same status page twice every cycle.
            snapshot = await fetchSnapshot(statuspageRecord, { token, locale })
            fetched += 1
        } catch (error) {
            // Render nothing for this group. Publishing an empty result would replace a
            // perfectly good status message with "no categories available" every time the
            // network hiccups — the message must keep its last known good content.
            firstError = firstError || error
            continue
        }

        // Concurrently, each with its own deadline: a channel that stalls holds up itself and
        // nothing else. They were delivered one after the other, so the channel after a stuck
        // one waited for it — see util/delivery.js.
        await forEachLimited(subscriptions, DELIVERY_CONCURRENCY, async (subscription) => {
            if (!subscription.eventTypes.STATUS) return

            try {
                // Its own locale slot: the renderer selects a language and the delivery that
                // follows awaits, and the loop runs 100 pages and both handlers concurrently.
                // Without this the last flow to resume decides the language for all of them.
                const outcome = await deliver(subscription, 'status', () =>
                    withLocale(subscription.locale || 'de', () => deliverStatus(subscription, snapshot, client)))
                if (outcome.status === 'done') logDeliverySuccess('status', subscription)
            } catch (error) {
                if (isChannelGone(error)) {
                    logger.info(
                        `[handleStatusPage] Channel ${subscription.channelId} unavailable (${error.code}), removing subscription ${subscription.id}`
                    )
                    // Braked: see util/subscriptionReaper.js. A wrong token makes EVERY channel
                    // answer 10003, and this is the line that would delete every subscription.
                    if (!claimReap()) return
                    await models.Subscription.destroy({ where: { id: subscription.id } })
                    return
                }

                // A delivery failure belongs to THIS channel, not to the status page, and it
                // must not travel any further. Letting it out of the handler advanced the
                // page's backoff, so a single guild that revoked "Send Messages" (50013) could
                // pause the page and announce "unreachable" to every OTHER guild watching it.
                // The channel gets its own backoff instead (util/delivery.js).
                logDeliveryFailure('handleStatusPage', 'status', subscription, error)
            }
        })
    }

    // Every token/locale group failed: the page itself is the problem, so let the update
    // loop see it and advance the backoff.
    if (fetched === 0 && firstError) {
        throw firstError
    }
}
