import models from '../models/index.js'
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors, EmbedBuilder } from 'discord.js'
import { fetchSnapshot, fetchClosedAlert } from '../providers/index.js'
import { truncate } from '../util/String.js'
import { bodyToDiscord } from '../util/markdown.js'
import { buildRoleMentions } from '../util/roleMentions.js'
import translation, { withLocale } from '../util/Translation.js'
import logger from '../util/logger.js'
import { groupSubscriptions } from '../util/subscriptionGroups.js'
import { syncMessage, isChannelGone } from '../util/messageSync.js'
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

/**
 * Headline for one update inside a thread.
 *
 * A self-hosted sub-alert carries its own headline ("Hotline Störung behoben") and keeps it.
 * A Cloud update has none — only a state — so without this every message in a thread would
 * repeat the incident's title and a reader would have to open each one to find the resolution.
 *
 * The suffix mirrors the Cloud's own RSS feed (`${title} — ${statusLabel}` in feed.ts) using
 * the same wording as its i18n files, so the bot never phrases a state differently from the
 * page it reports on. A notice has no state and falls through unchanged.
 */
const updateTitle = (update, alert, snapshot, locale) => {
    if (update.title) {
        return resolveText(update.title, locale, snapshot.defaultLocale);
    }

    const base = resolveText(alert.title, locale, snapshot.defaultLocale);
    if (!update.state) return base;

    const key = `messages.alerts.state.${alert.kind}.${update.state}`;
    const label = translation.trans(key);

    // An unknown state prints its key; better to keep the plain title than to show that.
    return label === key ? base : `${base} — ${label}`;
};

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

    const getChannel = () => client.channels.fetch(subscription.channelId)

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
        channel: getChannel,
        record: parentRecord,
        payload: {
            content: mentions.content || undefined,
            embeds: [embed],
            components: [row],
            ...(mentions.roleIds.length > 0 ? { allowedMentions: mentions.allowedMentions } : {}),
        },
        models,
        create: { subscriptionId: subscription.id, category: 'NEWS', serviceId: alert.id, kind: alert.kind },
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
            channel: getChannel,
            record,
            payload: {
                embeds: [buildAlertEmbed(
                    { title: updateTitle(update, alert, snapshot, locale), body: update.body },
                    alert, snapshot, locale, footer, update.createdAt
                )],
                components: [linkRow(alert.url, updateLabel)],
            },
            models,
            create: { subscriptionId: subscription.id, category: 'ALERT', serviceId: update.id, kind: alert.kind },
            send: (payload, channel) => channel.send({
                ...payload,
                reply: { messageReference: parentId, failIfNotExists: false },
            }),
        })
    }
}

/**
 * Finish the threads of alerts that have left the live payload.
 *
 * The Cloud removes an incident from `active_incidents` the moment it resolves, so without
 * this a Discord thread keeps its last seen update forever — usually "we are monitoring",
 * which reads as an ongoing outage long after everything is fine.
 *
 * THREE RULES THIS FOLLOWS
 *
 *  1. Only reconcile what is still in the reporting window. Beyond it a thread is left alone
 *     for good, which is also what stops this re-querying a thread that can never be closed.
 *  2. Never claim an ending it cannot see. When the page makes the resolved incident
 *     unreachable (`show_incident_history` off → 404), the thread simply keeps its last
 *     legitimate state. Silence is the honest answer, not a guess.
 *  3. Post only what is missing. The closing update is delivered as one more reply in the same
 *     thread, through the same syncMessage path — so a second pass adds nothing.
 *
 * Costs nothing in steady state: the lookup happens only for an alert that actually vanished,
 * and the result is shared across every subscription watching the same page.
 */
/**
 * How long to leave a vanished alert alone between close-out attempts.
 *
 * A row whose alert has left the live payload fails the "still live" test on EVERY cycle for
 * as long as the reporting window lasts, and the provider memo has a 10s TTL against a 15s
 * cycle, so it never carried across cycles either. The result was one detail request every 15
 * seconds for three days — about 17,000 per resolved incident, per token/locale group, and
 * double that when `show_incident_history` is off and both endpoints 404 every time while
 * nothing is ever delivered. All of it against the Cloud's shared edge budget.
 *
 * Half an hour cuts that by 99% and still picks up a late edit — a postmortem attached after
 * the fact — within one cooldown. Deliberately NOT "settled for ever": an alert can still
 * change after it resolves, and the point is to stop hammering, not to stop looking.
 */
const CLOSEOUT_RECHECK_MS = Number(process.env.ALERT_CLOSEOUT_RECHECK_MS || 30 * 60 * 1000);

/** `${statuspageId}:${alertId}` → when it was last asked about. Memory only, by design. */
const closeoutAttempts = new Map();
const MAX_CLOSEOUT_KEYS = 5000;

const recentlyAttempted = (statuspageId, alertId) => {
    const at = closeoutAttempts.get(`${statuspageId}:${alertId}`);
    return at !== undefined && Date.now() - at < CLOSEOUT_RECHECK_MS;
};

const rememberAttempt = (statuspageId, alertId) => {
    if (closeoutAttempts.size >= MAX_CLOSEOUT_KEYS) {
        const oldest = closeoutAttempts.keys().next().value;
        if (oldest !== undefined) closeoutAttempts.delete(oldest);
    }
    closeoutAttempts.set(`${statuspageId}:${alertId}`, Date.now());
};

/** Forget the cooldowns. Exposed for tests. */
export const clearCloseoutCooldowns = () => closeoutAttempts.clear();

const reconcileClosedAlerts = async (subscriptions, snapshot, statuspageRecord, locale, footer, client) => {
    const stillLive = new Set(snapshot.alerts.map((alert) => alert.id))
    const cutoff = Date.now() - ALERT_WINDOW_MS

    for (const subscription of subscriptions) {
        if (!subscription.eventTypes.NEWS) continue

        const posted = await models.Message.findAll({
            where: { subscriptionId: subscription.id, category: 'NEWS' },
        })

        for (const record of posted) {
            if (!record.serviceId || stillLive.has(record.serviceId)) continue
            // Outside the window the thread stays as it is, permanently. This is the bound
            // that keeps an unconfirmable alert from being re-checked every cycle forever.
            if (new Date(record.createdAt).getTime() < cutoff) continue

            // Asked about recently enough. Without this the same request went out every 15
            // seconds for the full three days — see CLOSEOUT_RECHECK_MS.
            if (recentlyAttempted(statuspageRecord.id, record.serviceId)) continue
            rememberAttempt(statuspageRecord.id, record.serviceId)

            // The kind the bot ORIGINALLY saw is passed in. The Cloud's detail endpoint
            // returns a notice shaped exactly like an incident and says nothing about which
            // it is, so without this a closed advisory came back red with an outage severity.
            const closed = await fetchClosedAlert(statuspageRecord, record.serviceId, record.kind || null)
            if (!closed) continue

            try {
                await withLocale(locale, () => deliverAlert(subscription, closed, snapshot, locale, footer, client))
            } catch (error) {
                // The same guard the live path has, which this loop was missing. Without it
                // one guild that revoked "Send Messages" aborted the whole reconciliation:
                // every OTHER guild's thread stayed on "we are investigating" and read as an
                // ongoing outage, and it never recovered — the same error threw every cycle
                // until the three-day window closed the thread out of scope for good.
                if (isChannelGone(error)) {
                    logger.info(
                        `[handleAlerts] Channel ${subscription.channelId} unavailable (${error.code}), removing subscription ${subscription.id}`
                    )
                    await models.Subscription.destroy({ where: { id: subscription.id } })
                    continue
                }

                logger.once(
                    `deliver:${subscription.id}`, 'error',
                    `[handleAlerts] Could not close out in channel ${subscription.channelId} ` +
                    `(${error.code ?? error.name}): ${error.message}`
                )
            }
        }
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

        // Set for the synchronous work below; every delivery opens its own scope, because
        // this is a singleton the concurrently running status renderer also writes to.
        translation.setLocale(locale)
        const footer = resolveText(snapshot.name, locale, snapshot.defaultLocale) || statuspageRecord.name

        // No early exit on an empty list: an EMPTY alert list is the normal shape of a page
        // whose incident has just been resolved, and that is precisely when the threads below
        // still need finishing.
        for (const alert of recentAlerts) {
            for (const subscription of subscriptions) {
                try {
                    await withLocale(locale, () => deliverAlert(subscription, alert, snapshot, locale, footer, client))
                    logger.resetOnce(`deliver:${subscription.id}`)
                } catch (error) {
                    if (isChannelGone(error)) {
                        logger.info(
                            `[handleAlerts] Channel ${subscription.channelId} unavailable (${error.code}), removing subscription ${subscription.id}`
                        )
                        await models.Subscription.destroy({ where: { id: subscription.id } })
                        continue
                    }

                    // See handleStatusPage: a channel-level failure must not advance the
                    // status page's backoff or pause it for everyone else.
                    logger.once(
                        `deliver:${subscription.id}`, 'error',
                        `[handleAlerts] Could not deliver to channel ${subscription.channelId} ` +
                        `(${error.code ?? error.name}): ${error.message}`
                    )
                }
            }
        }

        try {
            await reconcileClosedAlerts(subscriptions, snapshot, statuspageRecord, locale, footer, client)
        } catch (error) {
            // Closing out is best-effort: a page that cannot be reached for the lookup must not
            // fail the whole cycle, because the live part already succeeded.
            logger.failure('[handleAlerts] close-out', statuspageRecord.url, error, `closeout:${statuspageRecord.id}`)
        }
    }

    if (fetched === 0 && firstError) {
        throw firstError
    }
}
