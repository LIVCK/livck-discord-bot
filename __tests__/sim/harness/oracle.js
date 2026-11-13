/**
 * What every channel must look like, worked out from the simulated world — and where the
 * channels as they are differ from it.
 *
 * The world is known exactly: which pages exist, what is on them, which incidents were opened,
 * updated, resolved or taken down, who subscribed where and when. From that alone this says,
 * for each subscription's channel:
 *
 *   STATUS  exactly one status message, and it is what the real renderer makes of the page
 *           right now — the same fetch and the same layout code the bot uses, so a status
 *           message that is stale, missing or doubled is a difference.
 *   NEWS    for every incident that started after the subscription and is still on the page:
 *           one announcement, then one reply per later update, in order, each a reply to that
 *           announcement and carrying that update's text. An incident taken off the page has
 *           nothing left in the channel. A resolved incident on a page that hides its history
 *           keeps its last update before the resolution — the bot cannot see the ending, and
 *           must not invent one.
 *   NOTHING ELSE — any other message in the channel is a difference too.
 *
 * Deliberately not a copy of the bot's logic: the announcement/reply structure is written down
 * here from what a reader should see, and only the status embed borrows the real renderer,
 * because re-implementing five layouts would test the copy, not the bot.
 */

import { fetchSnapshot, clearSnapshotCache } from '../../../providers/index.js';
import { getLayoutRenderer } from '../../../messages/layoutRenderers.js';
import { withLocale } from '../../../util/Translation.js';

const text = (localized, locale) => (typeof localized === 'string' ? localized : localized?.[locale] ?? localized?.de ?? '');

const strip = (embeds) => JSON.stringify((embeds ?? []).map((embed) => {
    const json = typeof embed?.toJSON === 'function' ? embed.toJSON() : embed;
    const { timestamp: _t, ...rest } = json;
    return rest;
}));

/** The updates of an incident a subscriber should see, chronological. */
const visibleUpdates = (page, incident) => {
    if (incident.status === 'resolved' && !page.showHistory) {
        return incident.updates.filter((u) => u.status !== 'resolved');
    }
    return incident.updates;
};

/**
 * @param {object} world
 * @param {object} world.discord - sim Discord
 * @param {object} world.pages - sim pages
 * @param {Array} world.subscriptions - rows joined with their page: {id, channelId, locale, layout,
 *   eventTypes, createdAt, url, name, kind, externalId}
 * @returns {Promise<string[]>} every difference, empty when the channels are exactly right
 */
export const differences = async ({ discord, pages, subscriptions }) => {
    const problems = [];
    const byChannel = new Map();
    for (const sub of subscriptions) {
        if (!byChannel.has(sub.channelId)) byChannel.set(sub.channelId, []);
        byChannel.get(sub.channelId).push(sub);
    }

    clearSnapshotCache();

    for (const [channelId, subs] of byChannel) {
        const remaining = new Map(discord.messagesIn(channelId).map((m) => [m.id, m]));
        const where = `channel ${channelId}`;

        for (const sub of subs) {
            const { slug, pages: owner } = pages.locate(sub.url);
            const page = owner.page(slug);
            const events = typeof sub.eventTypes === 'string' ? JSON.parse(sub.eventTypes) : sub.eventTypes;

            if (events.STATUS) {
                let expected;
                try {
                    const snapshot = await fetchSnapshot({ url: sub.url, name: sub.name, kind: sub.kind, externalId: sub.externalId }, { locale: sub.locale });
                    expected = strip(withLocale(sub.locale, () => getLayoutRenderer(sub.layout)(snapshot, sub.locale).map((r) => r.embed)));
                } catch (error) {
                    problems.push(`${where}: could not render the expected status (${error.message})`);
                }
                const candidates = [...remaining.values()].filter((m) => !m.message_reference && strip(m.embeds) === expected);
                const status = candidates[0];
                if (!status) {
                    const stale = [...remaining.values()].filter((m) => !m.message_reference && (m.embeds?.[0]?.title ?? '') === JSON.parse(expected ?? '[{}]')[0]?.title);
                    problems.push(stale.length > 0
                        ? `${where}: status message ${stale[0].id} is stale (${sub.layout}/${sub.locale})`
                        : `${where}: no status message for subscription ${sub.id} (${sub.layout}/${sub.locale})`);
                } else {
                    remaining.delete(status.id);
                    if (candidates.length > 1) problems.push(`${where}: ${candidates.length} identical status messages`);
                }
            }

            if (!events.NEWS) continue;

            for (const incident of owner.incidents(slug)) {
                const title = text(incident.title, sub.locale);
                const mine = [...remaining.values()].filter((m) => (m.embeds?.[0]?.title ?? '').includes(title));
                const tooOld = new Date(incident.startedAt) < new Date(sub.createdAt);

                if (incident.removed || tooOld || !incident.seenLive) {
                    for (const m of mine) {
                        problems.push(`${where}: ${m.id} is about "${title}", which ${incident.removed ? 'was taken off the page' : tooOld ? 'predates the subscription' : 'was never live'}`);
                        remaining.delete(m.id);
                    }
                    continue;
                }

                const updates = visibleUpdates(page, incident);
                const parents = mine.filter((m) => !m.message_reference);
                // Resolved on a page that hides its history: from then on the bot cannot see it at
                // all. Whatever reached the channel while it was live stays — possibly nothing, if
                // the channel was unreachable the whole time. So: an unbroken beginning of the
                // live timeline, in order, nothing twice, nothing beyond it. Never an ending.
                const unknowable = incident.status === 'resolved' && !page.showHistory;
                if (unknowable && parents.length === 0) {
                    const strays = mine.filter((m) => m.message_reference);
                    strays.forEach((m) => { problems.push(`${where}: reply ${m.id} to "${title}" without its announcement`); remaining.delete(m.id); });
                    continue;
                }
                if (parents.length !== 1) {
                    problems.push(`${where}: ${parents.length} announcements of "${title}", expected 1`);
                    mine.forEach((m) => remaining.delete(m.id));
                    continue;
                }
                const [parent] = parents;
                remaining.delete(parent.id);
                if (!(parent.embeds?.[0]?.description ?? '').includes(text(updates[0].message, sub.locale))) {
                    problems.push(`${where}: announcement of "${title}" does not carry its first update`);
                }

                const replies = [...remaining.values()].filter((m) => m.message_reference?.message_id === parent.id);
                const expectedReplies = updates.slice(1);
                if (unknowable ? replies.length > expectedReplies.length : replies.length !== expectedReplies.length) {
                    problems.push(`${where}: "${title}" has ${replies.length} replies, expected ${expectedReplies.length}`);
                }
                expectedReplies.forEach((update, i) => {
                    const reply = replies[i];
                    const want = text(update.message, sub.locale);
                    if (reply && !(reply.embeds?.[0]?.description ?? '').includes(want)) {
                        problems.push(`${where}: reply ${i + 1} of "${title}" should say "${want}", says "${(reply.embeds?.[0]?.description ?? '').slice(0, 80)}"`);
                    }
                });
                replies.forEach((r) => remaining.delete(r.id));
            }
        }

        for (const extra of remaining.values()) {
            problems.push(`${where}: unexpected message ${extra.id}${extra.message_reference ? ' (reply)' : ''} "${(extra.embeds?.[0]?.title ?? extra.content ?? '').slice(0, 60)}"`);
        }
    }
    return problems;
};

export default { differences };
