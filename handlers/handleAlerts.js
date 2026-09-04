import models from '../models/index.js'
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors, EmbedBuilder } from 'discord.js'
import { fetchSnapshot } from '../providers/index.js'
import { truncate } from '../util/String.js'
import { bodyToDiscord } from '../util/markdown.js'
import { buildRoleMentions } from '../util/roleMentions.js'
import translation from '../util/Translation.js'
import logger from '../util/logger.js'
import { groupSubscriptions } from '../util/subscriptionGroups.js'
import { syncMessage, UNKNOWN_CHANNEL, MISSING_ACCESS } from '../util/messageSync.js'
import { ALERT_KIND, resolveText } from '../dto/statuspage.js'

/** Alerts older than this are no longer tracked. */
const ALERT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000

/** Embed description budget, so a pasted postmortem cannot fill a channel. */
const BODY_MAX = 500

/**
 * Colour for an alert.
 *
 * A NOTICE is never red and never urgent-looking, whatever else is going on: the Cloud is
 * explicit that a standing advisory makes no claim about the platform, and a two-year-old
 * phishing warning must not look like an outage. It carries no severity at all, which is what
 * makes that unrepresentable rather than merely discouraged.
 */
const alertColor = (alert) => {
    if (alert.kind === ALERT_KIND.NOTICE) return Colors.Blurple
    if (alert.kind === ALERT_KIND.MAINTENANCE) return Colors.Yellow
    return alert.severity === 'minor' ? Colors.Orange : Colors.Red
}

/**
 * @param {object} item - an alert or one of its updates
 * @param {object} alert - the alert the item belongs to (for url and body format)
 */
const buildAlertEmbed = (item, alert, snapshot, locale, footer, timestamp) => new EmbedBuilder()
    .setColor(alertColor(alert))
    .setTitle(truncate(resolveText(item.title, locale, snapshot.defaultLocale), 256))
    .setDescription(truncate(bodyToDiscord(resolveText(item.body, locale, snapshot.defaultLocale), alert.format), BODY_MAX))
    .setURL(alert.url)
    .setTimestamp(new Date(timestamp))
    .setFooter({ text: footer })

const linkRow = (link, label) => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(link)
)

/**
 * Deliver one alert (and its follow-up updates) to one subscription.
 *
 * The alert becomes a message; every later update is posted as a reply to it, so a timeline
 * reads as a thread. Replies are addressed by message ID via `reply.messageReference` — the
 * parent is never fetched.
 */
const deliverAlert = async (subscription, alert, snapshot, locale, footer, client) => {
    if (!subscription.eventTypes.NEWS) return

    // Do not backfill a channel with alerts that predate its subscription.
    if (new Date(subscription.createdAt).getTime() > new Date(alert.startedAt).getTime()) return

    const channel = await client.channels.fetch(subscription.channelId)
    if (!channel) return

    const embed = buildAlertEmbed(alert, alert, snapshot, locale, footer, alert.startedAt)
    const row = linkRow(alert.url, translation.trans('messages.alerts.view_button'))

    const parentRecord = await models.Message.findOne({
        where: { subscriptionId: subscription.id, serviceId: alert.id, category: 'NEWS' },
    })

    // Role pings fire only for a NEW message: Discord does not re-notify on edit, so attaching
    // them to an update would be noise without a ping. A notice never pings at all — it is not
    // an outage and must not wake anyone.
    const mentions = (parentRecord || alert.kind === ALERT_KIND.NOTICE)
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
        create: { subscriptionId: subscription.id, category: 'NEWS', serviceId: alert.id },
    })

    // The parent was deleted in Discord; it is recreated next cycle, and replies would have
    // nothing to hang under until then.
    if (parentResult === 'recreate') return

    const parentId = parentRecord
        ? parentRecord.messageId
        : (await models.Message.findOne({
            where: { subscriptionId: subscription.id, serviceId: alert.id, category: 'NEWS' },
        }))?.messageId

    if (!parentId) return

    const updateLabel = translation.trans('messages.alerts.update_button')

    for (const update of alert.updates) {
        const record = await models.Message.findOne({
            where: { subscriptionId: subscription.id, serviceId: update.id, category: 'ALERT' },
        })

        await syncMessage({
            channel,
            record,
            payload: {
                embeds: [buildAlertEmbed(
                    { title: update.title ?? alert.title, body: update.body },
                    alert, snapshot, locale, footer, update.createdAt
                )],
                components: [linkRow(alert.url, updateLabel)],
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
        let snapshot

        try {
            // Shares the memoized fetch with handleStatusPage — see providers/index.js.
            snapshot = await fetchSnapshot(statuspageRecord, { token, locale })
            fetched += 1
        } catch (error) {
            firstError = firstError || error
            continue
        }

        const now = Date.now()
        const recentAlerts = snapshot.alerts.filter(
            (alert) => now - new Date(alert.startedAt).getTime() <= ALERT_WINDOW_MS
        )

        if (recentAlerts.length === 0) continue

        translation.setLocale(locale)
        const footer = resolveText(snapshot.name, locale, snapshot.defaultLocale) || statuspageRecord.name

        for (const alert of recentAlerts) {
            for (const subscription of subscriptions) {
                try {
                    await deliverAlert(subscription, alert, snapshot, locale, footer, client)
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
