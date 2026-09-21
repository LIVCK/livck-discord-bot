import { EmbedBuilder } from "discord.js";
import translation from "../util/Translation.js";
import { getStatusDot } from "../config/emojis.js";
import { STATUS, resolveText } from "../dto/statuspage.js";
import {
    DISCORD_LIMITS,
    capFields,
    embedLength,
    enforceMessageBudget,
    joinWithinLimit,
    padInlineRows,
    truncate,
} from "../util/discordLimits.js";

/**
 * Overflow helpers.
 *
 * Every one of these is a no-op while the content fits — Discord's limits are only reached
 * by unusually large status pages, and the ordinary output must stay byte-identical (see
 * __tests__/messages/layoutRenderers.golden.test.js).
 */

/** "+N more" line inside a field value or description. */
const moreServicesLine = (count) => translation.trans('messages.status.more_services', { count });

/** Final field standing in for the categories that did not fit. */
const moreCategoriesField = (count) => ({
    name: translation.trans('messages.status.more_categories_field.name'),
    value: translation.trans('messages.status.more_categories_field.value', { count }),
    inline: false,
});

/** Join service lines into one field value, dropping the tail that does not fit. */
const serviceLines = (lines) => joinWithinLimit(lines, {
    max: DISCORD_LIMITS.EMBED_FIELD_VALUE,
    more: moreServicesLine,
});

/**
 * Clamp a built description to Discord's limit.
 *
 * The layouts build their description by concatenation and must keep producing exactly that
 * string while it fits; only an over-long one is rebuilt line by line.
 */
const clampDescription = (description) => {
    if (description.length <= DISCORD_LIMITS.EMBED_DESCRIPTION) return description;
    return joinWithinLimit(description.split('\n'), {
        max: DISCORD_LIMITS.EMBED_DESCRIPTION,
        more: moreServicesLine,
    });
};

/**
 * Cap the field list, bring the embed under the per-message budget, and report the total
 * number of categories that did not make it.
 *
 * Two stages can drop fields — the 25-field cap and the 6000-character budget — so neither
 * of them writes the overflow marker: each would only know about its own losses and the
 * reader would be told "+6 more" when 54 are missing. The count is summed here and written
 * once, and the marker itself is added only if it still fits (dropping one more field to
 * make room if needed).
 *
 * Padding runs last, so the zero-width filler is never mistaken for a dropped category.
 */
const finalizeEmbed = (embed, fields, { inline = false } = {}) => {
    const capped = capFields(fields);
    let hidden = fields.length - capped.length;

    embed.setFields(capped);
    enforceMessageBudget([embed]);
    hidden += capped.length - (embed.toJSON().fields || []).length;

    if (hidden > 0) {
        let current = embed.toJSON().fields || [];
        let marker = moreCategoriesField(hidden);

        // Cost of the marker measured arithmetically rather than by building a probe embed:
        // EmbedBuilder validates on construction, and this runs on already-clamped input.
        const fits = () => embedLength(embed.toJSON()) + marker.name.length + marker.value.length
            <= DISCORD_LIMITS.MESSAGE_EMBED_TOTAL
            && current.length + 1 <= DISCORD_LIMITS.EMBED_FIELDS;

        while (current.length > 0 && !fits()) {
            // No room for the marker: give up one more category and say so.
            current = current.slice(0, -1);
            embed.setFields(current);
            hidden += 1;
            marker = moreCategoriesField(hidden);
        }

        if (fits()) embed.setFields([...current, marker]);
    }

    if (inline) {
        // The budget is passed in: padding must not be what pushes the message over 6000.
        const json = embed.toJSON();
        embed.setFields(padInlineRows(json.fields || [], { used: embedLength(json) }));
    }

    return embed;
};

/**
 * Get status emoji for a monitor
 * @param {string} status - Monitor status
 * @returns {string} Status emoji
 */
export const getStatusEmoji = (status) => {
    switch (status) {
        case STATUS.OPERATIONAL:
            return '<a:status_up:1344187859921535047>';
        case STATUS.MAJOR_OUTAGE:
            return '<a:status_down:1344187930499088394>';
        default:
            // THE COLOURED DOT, not a question mark.
            //
            // Custom animated emoji exist for exactly two states. Everything else fell through
            // to `❔`, which put FIVE distinct statuses on one symbol in the default layout:
            // degraded, partial_outage, under_maintenance, unknown and the page-level
            // maintenance. A reader could not tell a planned maintenance window from a service
            // the bot knows nothing about, and neither from a partial failure.
            //
            // `getStatusDot` has carried the right staffing all along — amber for degraded and
            // partial, blue for maintenance, a plain dot for unknown — and the compact and tree
            // layouts have been using it correctly. This is the same vocabulary, reached from
            // here too, so the two states that DO have an icon keep it and the rest stop
            // pretending to be the same thing.
            return getStatusDot(status);
    }
};

/**
 * Get embed color based on overall status
 * @param {string} status - Overall status (AVAILABLE, UNAVAILABLE, DEGRADED)
 * @returns {number} Discord color value
 */
export const getEmbedColor = (status) => {
    switch (status) {
        case STATUS.OPERATIONAL:
            return 0x2ecc71; // Green
        case STATUS.MAJOR_OUTAGE:
            return 0xe74c3c; // Red
        case STATUS.DEGRADED:
        case STATUS.PARTIAL_OUTAGE:
            return 0xf39c12; // Yellow/Orange
        case STATUS.UNDER_MAINTENANCE:
        case STATUS.MAINTENANCE:
            return 0x3498db; // Blue
        default:
            return 0x95a5a6; // Gray
    }
};

/**
 * Resolve a page/group/service name for this locale, falling back to the translated
 * placeholder when the source has none. Self-hosted names are plain strings and pass through
 * unchanged; Cloud names are locale maps.
 */
const nameOf = (value, snapshot, locale, fallbackKey = 'messages.status.unknown_category') =>
    resolveText(value, locale, snapshot.defaultLocale) || translation.trans(fallbackKey);

/**
 * A group's display name.
 *
 * A group the bot invented (the bucket for components with no group of their own) carries a
 * translation key instead of a name, because one snapshot is rendered once per subscription
 * and those subscriptions are in different languages — a string resolved in the adapter would
 * show German in an English channel.
 */
const groupName = (group, snapshot, locale) =>
    (group.labelKey ? translation.trans(group.labelKey) : nameOf(group.name, snapshot, locale));

/** Services in a group that are fully up / fully down. */
const countUp = (services) => services.filter((s) => s.status === STATUS.OPERATIONAL).length;
const countDown = (services) => services.filter((s) => s.status === STATUS.MAJOR_OUTAGE).length;

/**
 * Service counts for a group, and whether the bot may state them.
 *
 * A Cloud group with `hide_operational_children` ships only its AFFECTED children and reports
 * how many healthy ones it left out. The statuspage renders that summary under exactly one
 * condition — `isGroup && collapseOperational && affectedCount > 0` in HorizonComponentItem.vue
 * — so while everything behind such a group is healthy, the page states NO number at all.
 *
 * The bot mirrors that. Printing "66 services operational" for a quiet group would disclose a
 * fleet size the operator deliberately keeps off their own page, and the bot must never show
 * more than the page it reports on.
 *
 * `disclose` is false only for a hiding group with nothing affected. A normal group has
 * `childrenTotal === null` and always discloses, which is what keeps self-hosted unchanged.
 */
const groupCounts = (group) => {
    const visibleUp = countUp(group.services);
    const down = countDown(group.services);

    // The page's own rule: count what is actually non-neutral rather than `total - hidden`,
    // which would treat a healthy kept sub-group as affected forever.
    const affected = group.services.filter(
        (s) => s.status !== STATUS.OPERATIONAL && s.status !== STATUS.UNKNOWN
    ).length;

    if (group.childrenTotal === null || group.childrenTotal === undefined) {
        return { up: visibleUp, down, total: group.services.length, affected, disclose: true };
    }

    return {
        up: visibleUp + (group.childrenHidden ?? 0),
        down,
        total: group.childrenTotal,
        affected,
        disclose: affected > 0,
    };
};

/** Human label for a status, for wherever a group shows no numbers. */
const describeStatus = (status) => {
    if (status === STATUS.OPERATIONAL) return translation.trans('messages.status.operational');
    if (status === STATUS.MAJOR_OUTAGE) return translation.trans('messages.status.critical');
    return translation.trans('messages.status.degraded');
};

/**
 * The service lines for a group's field value.
 *
 * Three things happen here that only ever apply to a Cloud page:
 *  - a nested sub-group becomes a bold heading, so five levels of tree survive as two levels
 *    of Discord structure (see providers/cloud.js);
 *  - beyond one level of nesting the ancestors become a breadcrumb instead of indentation,
 *    which stops being readable inside a 1024-character field;
 *  - hidden healthy children are summarised rather than omitted.
 */
const groupBody = (group, snapshot, locale) => {
    const { total, affected, disclose } = groupCounts(group);
    const lines = [];
    let lastPath = null;

    for (const service of group.services) {
        const path = service.path ?? [];
        const key = path.map((p) => resolveText(p, locale, snapshot.defaultLocale)).join(' / ');

        if (key !== lastPath) {
            if (key !== '') lines.push(`**${key}**`);
            lastPath = key;
        }

        const emoji = getStatusEmoji(service.status);
        const prefix = key === '' ? '' : '┗━ ';
        lines.push(`${prefix}${emoji} **${nameOf(service.name, snapshot, locale)}**`);
    }

    // Only when the page itself would show it — see groupCounts.
    if (disclose && group.childrenTotal !== null && group.childrenTotal !== undefined) {
        lines.push(translation.trans('messages.status.group_summary', { total, affected }, total));
    }

    // A hiding group with nothing affected lists nothing and states no number: just its own
    // status, which is all the page shows there too.
    if (lines.length === 0 && !disclose) {
        return `${getStatusDot(group.status)} ${describeStatus(group.status)}`;
    }

    return serviceLines(lines) || translation.trans('messages.status.no_services');
};

/** The embed every layout falls back to when a page lists nothing. */
/**
 * The page's own name, in this embed's title and footer.
 *
 * CLAMPED, because EmbedBuilder validates on construction and throws — and this was the one
 * string in the module that reached `setTitle` unclamped. `Statuspage.name` is a VARCHAR(255)
 * while the title breaks at 245, and a Cloud page's name is not length-bounded by the bot at
 * all, so a long enough name made every layout throw. The handler catches it per subscription,
 * which means the status message would simply freeze on its last content for ever, for every
 * subscriber of that page, with one log line and nothing a reader could see.
 */
/** The host, which is always meaningful and never a translation. */
const hostOf = (url) => {
    try {
        return new URL(url).hostname;
    } catch {
        return url || '';
    }
};

const titleFor = (snapshot, locale) => {
    // The HOST as the last resort, not the word "error".
    //
    // A page whose name resolves to nothing rendered as "Dienste von Fehler", which reads as
    // though something had gone wrong rather than as the name of a page. The adapters already
    // fall back to the stored name when the API omits one, but `??` does not catch a name that
    // is present and EMPTY — a translation cleared to null is stored, not removed. The
    // hostname is right in every one of those cases and needs no translation.
    const pageName = resolveText(snapshot.name, locale, snapshot.defaultLocale) || hostOf(snapshot.url);
    return {
        title: truncate(translation.trans('messages.status.title', { name: pageName }), DISCORD_LIMITS.EMBED_TITLE),
        footer: truncate(pageName, DISCORD_LIMITS.EMBED_FOOTER_TEXT),
    };
};

const emptyEmbed = (snapshot, locale) => {
    const { title, footer } = titleFor(snapshot, locale);
    return [{
        embed: new EmbedBuilder()
            .setTitle(title)
            .setDescription(translation.trans('messages.status.no_categories'))
            .setURL(snapshot.url)
            .setTimestamp(new Date())
            .setFooter({ text: footer }),
        type: 'single'
    }];
};

/** Title/URL/footer/timestamp — identical across every layout. */
const baseEmbed = (snapshot, locale, color) => {
    const { title, footer } = titleFor(snapshot, locale);
    return new EmbedBuilder()
        .setTitle(title)
        .setColor(color)
        .setURL(snapshot.url)
        .setTimestamp(new Date())
        .setFooter({ text: footer });
};

/**
 * Detailed Layout - every service, grouped.
 *
 * @param {Object} snapshot - dto/statuspage.js snapshot
 * @param {string} locale - the subscription's locale
 * @returns {Array<Object>} one entry per embed
 */
export const renderDetailedLayout = (snapshot, locale = 'de') => {
    translation.setLocale(locale);

    const groups = snapshot.groups || [];
    if (groups.length === 0) return emptyEmbed(snapshot, locale);

    const embed = baseEmbed(snapshot, locale, getEmbedColor(snapshot.overall));

    const fields = groups.map((group) => ({
        name: groupName(group, snapshot, locale),
        value: groupBody(group, snapshot, locale),
        inline: false // Default layout - full width, straight down
    }));

    finalizeEmbed(embed, fields);

    return [{ embed, type: 'single' }];
};

/**
 * Compact Layout - one tile per group with a counter instead of the service list.
 */
export const renderCompactLayout = (snapshot, locale = 'de') => {
    translation.setLocale(locale);

    const groups = snapshot.groups || [];
    if (groups.length === 0) return emptyEmbed(snapshot, locale);

    const embed = baseEmbed(snapshot, locale, getEmbedColor(snapshot.overall));

    const fields = groups.map((group) => {
        const { up, down, total, disclose } = groupCounts(group);

        const statusDot = getStatusDot(group.status);
        const statusLabel = describeStatus(group.status);

        // A hiding group with nothing affected gets no fraction — the count is the very thing
        // the page withholds there — and no second line, which would only repeat the label.
        let statusText;
        if (!disclose) {
            statusText = `┃ ${statusDot} ${statusLabel}`;
        } else {
            statusText = `┃ **${up}/${total}** ${translation.trans('messages.status.services')}`;
            statusText += down > 0
                ? `\n┗━ ${statusDot} **${down}** ${translation.trans('messages.status.down')}`
                : `\n┗━ ${statusDot} ${statusLabel}`;
        }

        return {
            name: groupName(group, snapshot, locale),
            value: statusText || translation.trans('messages.status.no_services'),
            inline: true
        };
    });

    finalizeEmbed(embed, fields, { inline: true });

    return [{ embed, type: 'single' }];
};

/**
 * Overview Layout - page summary plus one compact tile per group.
 */
export const renderOverviewLayout = (snapshot, locale = 'de') => {
    translation.setLocale(locale);

    const groups = snapshot.groups || [];
    if (groups.length === 0) return emptyEmbed(snapshot, locale);

    // The page-wide total must not smuggle hidden systems back in through the summary line.
    const totals = groups.reduce((acc, group) => {
        const { up, total, disclose } = groupCounts(group);
        return disclose
            ? { up: acc.up + up, total: acc.total + total }
            : { up: acc.up + group.services.length, total: acc.total + group.services.length };
    }, { up: 0, total: 0 });
    const totalAvailable = totals.up;
    const totalUnavailable = totals.total - totalAvailable;

    const overallStatusDot = getStatusDot(snapshot.overall);
    let statusSummary;
    if (snapshot.overall === STATUS.OPERATIONAL) {
        statusSummary = `${overallStatusDot} ${translation.trans('messages.status.all_systems_operational')}`;
    } else if (snapshot.overall === STATUS.MAJOR_OUTAGE) {
        statusSummary = `${overallStatusDot} ${translation.trans('messages.status.system_issues_detected')}`;
    } else {
        statusSummary = `${overallStatusDot} ${translation.trans('messages.status.partial_degradation')}`;
    }

    let description = `${statusSummary}`;
    if (totalUnavailable > 0) {
        description += `\n\`\`\`diff\n- ${totalUnavailable} ${translation.trans('messages.status.services')} ${translation.trans('messages.status.down')}\n+ ${totalAvailable} ${translation.trans('messages.status.services')} ${translation.trans('messages.status.operational')}\n\`\`\``;
    } else {
        description += `\n\`\`\`diff\n+ ${totalAvailable}/${totals.total} ${translation.trans('messages.status.services')} ${translation.trans('messages.status.operational')}\n\`\`\``;
    }

    const embed = baseEmbed(snapshot, locale, getEmbedColor(snapshot.overall))
        .setDescription(clampDescription(description));

    const fields = groups.map((group) => {
        const { up, down, total, disclose } = groupCounts(group);

        let statusText = disclose
            ? `${getStatusDot(group.status)} ${up}/${total}`
            : `${getStatusDot(group.status)} ${describeStatus(group.status)}`;
        if (down > 0) {
            statusText += ` • **${down}** ${translation.trans('messages.status.down')}`;
        }

        return {
            name: groupName(group, snapshot, locale),
            value: statusText,
            inline: true
        };
    });

    finalizeEmbed(embed, fields, { inline: true });

    return [{ embed, type: 'single' }];
};

/**
 * Tree Layout - group headers with their services indented underneath.
 *
 * The service dot is deliberately binary here (up or down) rather than the group's three-way
 * dot: that is how this layout has always rendered, and the golden snapshots pin it.
 */
export const renderTreeLayout = (snapshot, locale = 'de') => {
    translation.setLocale(locale);

    const groups = snapshot.groups || [];
    if (groups.length === 0) return emptyEmbed(snapshot, locale);

    let description = '';

    groups.forEach((group, index) => {
        description += `**${getStatusDot(group.status)} ${groupName(group, snapshot, locale)}**\n`;

        group.services.forEach((service) => {
            // The service's OWN status. Collapsing everything non-operational to major_outage
            // painted a planned maintenance window and a degraded service the same red as a
            // total failure — which reads as worse than it is, and is the one direction a
            // status page must never err in.
            const dot = getStatusDot(service.status);
            description += `    ${dot} ${nameOf(service.name, snapshot, locale)}\n`;
        });

        // ANY group with nothing under it, not just a hiding one. A bare heading reads as
        // broken rather than as healthy, and the earlier version only covered the Cloud's
        // hiding groups: an ordinary empty category — a self-hosted one with no monitors yet,
        // or a Cloud group whose children are all invisible — has no `childrenTotal`, so
        // `disclose` is true, the guard was skipped and the heading was emitted alone. If it
        // is the only category, the whole description is one bold word.
        if (group.services.length === 0) {
            description += `    ${describeStatus(group.status)}\n`;
        }

        if (index < groups.length - 1) {
            description += '\n';
        }
    });

    const embed = baseEmbed(snapshot, locale, getEmbedColor(snapshot.overall))
        .setDescription(clampDescription(description));

    return [{ embed, type: 'single' }];
};

/**
 * Minimal Layout - names and dots, nothing else.
 */
export const renderMinimalLayout = (snapshot, locale = 'de') => {
    translation.setLocale(locale);

    const groups = snapshot.groups || [];
    if (groups.length === 0) return emptyEmbed(snapshot, locale);

    let description = '';

    groups.forEach((group, index) => {
        description += `**${groupName(group, snapshot, locale)}**\n`;

        group.services.forEach((service) => {
            // The service's OWN status. Collapsing everything non-operational to major_outage
            // painted a planned maintenance window and a degraded service the same red as a
            // total failure — which reads as worse than it is, and is the one direction a
            // status page must never err in.
            const dot = getStatusDot(service.status);
            description += `${dot} ${nameOf(service.name, snapshot, locale)}\n`;
        });

        // See the tree layout: no group may render as an empty heading, hiding or not.
        if (group.services.length === 0) {
            description += `${getStatusDot(group.status)} ${describeStatus(group.status)}\n`;
        }

        if (index < groups.length - 1) {
            description += '\n';
        }
    });

    const embed = baseEmbed(snapshot, locale, getEmbedColor(snapshot.overall))
        .setDescription(clampDescription(description));

    return [{ embed, type: 'single' }];
};

/**
 * Layout Renderer Factory
 * Returns the appropriate renderer function based on layout key
 *
 * @param {string} layoutKey - The layout key from LAYOUT_REGISTRY
 * @returns {Function} Renderer function
 */
export const getLayoutRenderer = (layoutKey) => {
    switch (layoutKey) {
        case 'DETAILED':
            return renderDetailedLayout;
        case 'COMPACT':
            return renderCompactLayout;
        case 'OVERVIEW':
            return renderOverviewLayout;
        case 'TREE':
            return renderTreeLayout;
        case 'MINIMAL':
            return renderMinimalLayout;
        default:
            return renderDetailedLayout; // Fallback to default
    }
};

export default {
    renderDetailedLayout,
    renderCompactLayout,
    renderOverviewLayout,
    renderTreeLayout,
    renderMinimalLayout,
    getLayoutRenderer,
    getStatusEmoji
};
