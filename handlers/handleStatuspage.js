import models from '../models/index.js'
import { getLayoutRenderer } from '../messages/layoutRenderers.js'
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js'
import { fetchSnapshot } from '../providers/index.js'
import logger from '../util/logger.js'
import { groupSubscriptions } from '../util/subscriptionGroups.js'
import { syncMessage, isChannelGone } from '../util/messageSync.js'
import { withLocale } from '../util/Translation.js'

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
const buildLinkButtons = (customLinks) => {
    if (customLinks.length === 0) return []

    const rows = []
    let current = []

    for (const link of customLinks.slice(0, MAX_BUTTONS)) {
        const button = new ButtonBuilder()
            .setLabel(link.label)
            .setURL(link.url)
            .setStyle(ButtonStyle.Link)

        if (link.emoji && (link.emoji.startsWith('<') || !link.emoji.startsWith(':'))) {
            button.setEmoji(link.emoji)
        }

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

    const record = await models.Message.findOne({
        where: { subscriptionId: subscription.id, category: 'STATUS' },
    })

    return syncMessage({
        // Resolved only if something is actually going to be sent — see util/messageSync.js.
        channel: () => client.channels.fetch(subscription.channelId),
        record,
        payload,
        models,
        create: { subscriptionId: subscription.id, category: 'STATUS' },
        // The embed timestamp is excluded from the hash, so refresh periodically to keep it
        // from looking stale on a page that has not changed in days.
        heartbeat: true,
    })
}

export const handleStatusPage = async (statuspageId, client) => {
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

        for (const subscription of subscriptions) {
            try {
                // Its own locale slot: the renderer selects a language and the delivery that
                // follows awaits, and the loop runs 100 pages and both handlers concurrently.
                // Without this the last flow to resume decides the language for all of them.
                await withLocale(subscription.locale || 'de', () => deliverStatus(subscription, snapshot, client))
                logger.resetOnce(`deliver:${subscription.id}`)
            } catch (error) {
                if (isChannelGone(error)) {
                    logger.info(
                        `[handleStatusPage] Channel ${subscription.channelId} unavailable (${error.code}), removing subscription ${subscription.id}`
                    )
                    await models.Subscription.destroy({ where: { id: subscription.id } })
                    continue
                }

                // A delivery failure belongs to THIS channel, not to the status page, and it
                // must not travel any further. Letting it out of the handler advanced the
                // page's backoff, so a single guild that revoked "Send Messages" (50013) could
                // pause the page and announce "unreachable" to every OTHER guild watching it.
                // Logged once per subscription until the message changes, and cleared above on
                // the first delivery that succeeds again.
                logger.once(
                    `deliver:${subscription.id}`, 'error',
                    `[handleStatusPage] Could not deliver to channel ${subscription.channelId} ` +
                    `(${error.code ?? error.name}): ${error.message}`
                )
            }
        }
    }

    // Every token/locale group failed: the page itself is the problem, so let the update
    // loop see it and advance the backoff.
    if (fetched === 0 && firstError) {
        throw firstError
    }
}
