import StatuspageService from '../services/statuspage.js'
import models from '../models/index.js'
import { getLayoutRenderer } from '../messages/layoutRenderers.js'
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js'
import LIVCK from '../api/livck.js'
import logger from '../util/logger.js'
import { groupSubscriptions } from '../util/subscriptionGroups.js'
import { syncMessage, UNKNOWN_CHANNEL, MISSING_ACCESS } from '../util/messageSync.js'

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
const deliverStatus = async (subscription, statuspageService, statuspageRecord, client) => {
    if (!subscription.eventTypes.STATUS) return 'ignored'

    const renderer = getLayoutRenderer(subscription.layout || 'DETAILED')
    const embeds = renderer(statuspageService, statuspageRecord, subscription.locale).map((r) => r.embed)

    const customLinks = await models.CustomLink.findAll({
        where: { subscriptionId: subscription.id },
        order: [['position', 'ASC']],
    })

    const payload = { embeds, components: buildLinkButtons(customLinks) }

    const channel = await client.channels.fetch(subscription.channelId)
    if (!channel) return 'ignored'

    const record = await models.Message.findOne({
        where: { subscriptionId: subscription.id, category: 'STATUS' },
    })

    return syncMessage({
        channel,
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
        const statuspageService = new StatuspageService(
            new LIVCK(statuspageRecord.url, 'v3', token, locale)
        )

        try {
            await statuspageService.fetchAll()
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
                await deliverStatus(subscription, statuspageService, statuspageRecord, client)
            } catch (error) {
                if (error.code === UNKNOWN_CHANNEL || error.code === MISSING_ACCESS) {
                    logger.info(
                        `[handleStatusPage] Channel ${subscription.channelId} unavailable (${error.code}), removing subscription ${subscription.id}`
                    )
                    await models.Subscription.destroy({ where: { id: subscription.id } })
                    continue
                }
                throw error
            }
        }
    }

    // Every token/locale group failed: the page itself is the problem, so let the update
    // loop see it and advance the backoff.
    if (fetched === 0 && firstError) {
        throw firstError
    }
}
