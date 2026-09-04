import StatuspageService from '../services/statuspage.js'
import models from '../models/index.js'
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors, EmbedBuilder } from 'discord.js'
import LIVCK from '../api/livck.js'
import { truncate } from '../util/String.js'
import { buildRoleMentions } from '../util/roleMentions.js'
import translation from '../util/Translation.js'
import logger from '../util/logger.js'
import { groupSubscriptions } from '../util/subscriptionGroups.js'
import { syncMessage, UNKNOWN_CHANNEL, MISSING_ACCESS } from '../util/messageSync.js'

/** Alerts older than this are no longer tracked. */
const ALERT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000

// Convert HTML to Discord Markdown
const convertHtmlToMarkdown = (html) => {
    if (!html) return ''

    let text = html

    // Convert HTML tags to Discord markdown
    text = text.replace(/<strong>(.*?)<\/strong>/gi, '**$1**')           // Bold
    text = text.replace(/<b>(.*?)<\/b>/gi, '**$1**')                     // Bold (b tag)
    text = text.replace(/<em>(.*?)<\/em>/gi, '*$1*')                     // Italic
    text = text.replace(/<i>(.*?)<\/i>/gi, '*$1*')                       // Italic (i tag)
    text = text.replace(/<s>(.*?)<\/s>/gi, '~~$1~~')                     // Strikethrough
    text = text.replace(/<del>(.*?)<\/del>/gi, '~~$1~~')                 // Strikethrough (del tag)
    text = text.replace(/<code>(.*?)<\/code>/gi, '`$1`')                 // Inline code
    text = text.replace(/<mark>(.*?)<\/mark>/gi, '**$1**')               // Marked (as bold, Discord has no highlight)
    text = text.replace(/<u>(.*?)<\/u>/gi, '__$1__')                     // Underline

    // Headings
    text = text.replace(/<h1>(.*?)<\/h1>/gi, '\n**$1**\n')               // H1 as bold
    text = text.replace(/<h2>(.*?)<\/h2>/gi, '\n**$1**\n')               // H2 as bold
    text = text.replace(/<h3>(.*?)<\/h3>/gi, '\n**$1**\n')               // H3 as bold
    text = text.replace(/<h4>(.*?)<\/h4>/gi, '\n**$1**\n')               // H4 as bold
    text = text.replace(/<h5>(.*?)<\/h5>/gi, '\n**$1**\n')               // H5 as bold
    text = text.replace(/<h6>(.*?)<\/h6>/gi, '\n**$1**\n')               // H6 as bold

    // Links
    text = text.replace(/<a\s+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, '[$2]($1)')

    // Lists
    text = text.replace(/<li>(.*?)<\/li>/gi, '• $1\n')                   // List items
    text = text.replace(/<\/?ul>/gi, '\n')                               // Unordered lists
    text = text.replace(/<\/?ol>/gi, '\n')                               // Ordered lists

    // Paragraphs and line breaks
    text = text.replace(/<\/p><p>/gi, '\n\n')                            // Paragraph breaks
    text = text.replace(/<p>/gi, '')                                     // Remove opening p tags
    text = text.replace(/<\/p>/gi, '\n')                                 // Closing p to newline
    text = text.replace(/<br\s*\/?>/gi, '\n')                            // Line breaks

    // Pre and code blocks
    text = text.replace(/<pre><code>(.*?)<\/code><\/pre>/gis, '```\n$1\n```') // Code blocks
    text = text.replace(/<pre>(.*?)<\/pre>/gis, '```\n$1\n```')          // Pre blocks

    // Remove remaining HTML tags
    text = text.replace(/<[^>]+>/g, '')

    // Decode HTML entities
    text = text.replace(/&nbsp;/g, ' ')
    text = text.replace(/&amp;/g, '&')
    text = text.replace(/&lt;/g, '<')
    text = text.replace(/&gt;/g, '>')
    text = text.replace(/&quot;/g, '"')
    text = text.replace(/&#39;/g, '\'')

    // Clean up excessive whitespace and line breaks
    text = text.replace(/\n{3,}/g, '\n\n')                               // Max 2 consecutive newlines
    text = text.replace(/[ \t]+/g, ' ')                                  // Multiple spaces to single space
    text = text.replace(/\n /g, '\n')                                    // Remove spaces after newlines

    return text.trim()
}

/** INCIDENT is red, a scheduled item amber, anything else informational. */
const alertColor = (alert) => {
    if (alert.type === 'INCIDENT') return Colors.Red
    if (alert.scheduled_for) return Colors.Yellow
    return Colors.Blurple
}

const buildAlertEmbed = (item, link, color, footer) => new EmbedBuilder()
    .setColor(color)
    .setTitle(item.title)
    .setDescription(truncate(convertHtmlToMarkdown(item.message), 500))
    .setURL(link)
    .setTimestamp(new Date(item.created_at))
    .setFooter({ text: footer })

const linkRow = (link, label) => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(link)
)

/**
 * Deliver one alert (and its follow-up updates) to one subscription.
 *
 * The parent alert becomes a message; every follow-up is posted as a reply to it, so a
 * timeline reads as a thread. Replies are addressed by message ID via `reply.messageReference`
 * — the parent is never fetched.
 */
const deliverAlert = async (subscription, newsItem, statuspageRecord, client) => {
    if (!subscription.eventTypes.NEWS) return

    // Do not backfill a channel with alerts that predate its subscription.
    if (new Date(subscription.createdAt).getTime() > new Date(newsItem.created_at).getTime()) return

    const channel = await client.channels.fetch(subscription.channelId)
    if (!channel) return

    const color = alertColor(newsItem)
    const footer = statuspageRecord.name
    const embed = buildAlertEmbed(newsItem, newsItem.link, color, footer)
    const row = linkRow(newsItem.link, translation.trans('messages.alerts.view_button'))

    const parentRecord = await models.Message.findOne({
        where: { subscriptionId: subscription.id, serviceId: newsItem.id, category: 'NEWS' },
    })

    // Role pings fire only for a NEW message: Discord does not re-notify on edit, so
    // attaching them to an update would be noise without a ping.
    const mentions = parentRecord
        ? { content: '', roleIds: [], allowedMentions: {} }
        : await buildRoleMentions(subscription.id, 'NEWS')

    const parentResult = await syncMessage({
        channel,
        record: parentRecord,
        payload: {
            content: mentions.content || undefined,
            embeds: [embed],
            components: [row],
            ...(mentions.roleIds.length > 0 ? { allowedMentions: mentions.allowedMentions } : {}),
        },
        models,
        create: { subscriptionId: subscription.id, category: 'NEWS', serviceId: newsItem.id },
    })

    // The parent was deleted in Discord; it is recreated next cycle, and replies would have
    // nothing to hang under until then.
    if (parentResult === 'recreate') return

    const parentId = parentRecord
        ? parentRecord.messageId
        : (await models.Message.findOne({
            where: { subscriptionId: subscription.id, serviceId: newsItem.id, category: 'NEWS' },
        }))?.messageId

    if (!parentId) return

    const updateLabel = translation.trans('messages.alerts.update_button')

    for (const update of newsItem.alerts || []) {
        const record = await models.Message.findOne({
            where: { subscriptionId: subscription.id, serviceId: update.id, category: 'ALERT' },
        })

        await syncMessage({
            channel,
            record,
            payload: {
                embeds: [buildAlertEmbed(update, newsItem.link, color, footer)],
                components: [linkRow(newsItem.link, updateLabel)],
            },
            models,
            create: { subscriptionId: subscription.id, category: 'ALERT', serviceId: update.id },
            send: (payload) => channel.send({
                ...payload,
                reply: { messageReference: parentId, failIfNotExists: false },
            }),
        })
    }
}

export const handleAlerts = async (statuspageId, client) => {
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
            await statuspageService.fetchAlerts()
            fetched += 1
        } catch (error) {
            firstError = firstError || error
            continue
        }

        const now = Date.now()
        const recentAlerts = (statuspageService.alerts || []).filter(
            (alert) => now - new Date(alert.created_at).getTime() <= ALERT_WINDOW_MS
        )

        if (recentAlerts.length === 0) continue

        translation.setLocale(locale)

        for (const newsItem of recentAlerts) {
            for (const subscription of subscriptions) {
                try {
                    await deliverAlert(subscription, newsItem, statuspageRecord, client)
                } catch (error) {
                    if (error.code === UNKNOWN_CHANNEL || error.code === MISSING_ACCESS) {
                        logger.info(
                            `[handleAlerts] Channel ${subscription.channelId} unavailable (${error.code}), removing subscription ${subscription.id}`
                        )
                        await models.Subscription.destroy({ where: { id: subscription.id } })
                        continue
                    }
                    throw error
                }
            }
        }
    }

    if (fetched === 0 && firstError) {
        throw firstError
    }
}
