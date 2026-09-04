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

    if (inline) embed.setFields(padInlineRows(embed.toJSON().fields || []));

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
            // Deliberately unchanged for now: `degraded` has always rendered as ❔ here, and
            // giving the richer Cloud states their own icons is a separate, visible change.
            return '❔';
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

/** Services in a group that are fully up / fully down. */
const countUp = (services) => services.filter((s) => s.status === STATUS.OPERATIONAL).length;
const countDown = (services) => services.filter((s) => s.status === STATUS.MAJOR_OUTAGE).length;

/** The embed every layout falls back to when a page lists nothing. */
const emptyEmbed = (snapshot, locale) => [{
    embed: new EmbedBuilder()
        .setTitle(translation.trans('messages.status.title', { name: nameOf(snapshot.name, snapshot, locale, 'messages.status.error') }))
        .setDescription(translation.trans('messages.status.no_categories'))
        .setURL(snapshot.url)
        .setTimestamp(new Date())
        .setFooter({ text: nameOf(snapshot.name, snapshot, locale, 'messages.status.error') }),
    type: 'single'
}];

/** Title/URL/footer/timestamp — identical across every layout. */
const baseEmbed = (snapshot, locale, color) => {
    const pageName = nameOf(snapshot.name, snapshot, locale, 'messages.status.error');
    return new EmbedBuilder()
        .setTitle(translation.trans('messages.status.title', { name: pageName }))
        .setColor(color)
        .setURL(snapshot.url)
        .setTimestamp(new Date())
        .setFooter({ text: pageName });
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
        name: nameOf(group.name, snapshot, locale),
        value: serviceLines(
            group.services.map((service) => {
                const emoji = getStatusEmoji(service.status);
                return `${emoji} **${nameOf(service.name, snapshot, locale)}**`;
            })
        ) || translation.trans('messages.status.no_services'),
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
        const services = group.services;
        const up = countUp(services);
        const down = countDown(services);

        const statusDot = getStatusDot(group.status);
        let statusLabel;
        if (group.status === STATUS.OPERATIONAL) {
            statusLabel = translation.trans('messages.status.operational');
        } else if (group.status === STATUS.MAJOR_OUTAGE) {
            statusLabel = translation.trans('messages.status.critical');
        } else {
            statusLabel = translation.trans('messages.status.degraded');
        }

        let statusText = `┃ **${up}/${services.length}** ${translation.trans('messages.status.services')}`;
        if (down > 0) {
            statusText += `\n┗━ ${statusDot} **${down}** ${translation.trans('messages.status.down')}`;
        } else {
            statusText += `\n┗━ ${statusDot} ${statusLabel}`;
        }

        return {
            name: nameOf(group.name, snapshot, locale),
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

    const services = groups.flatMap((group) => group.services);
    const totalAvailable = countUp(services);
    const totalUnavailable = services.length - totalAvailable;

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
        description += `\n\`\`\`diff\n+ ${totalAvailable}/${services.length} ${translation.trans('messages.status.services')} ${translation.trans('messages.status.operational')}\n\`\`\``;
    }

    const embed = baseEmbed(snapshot, locale, getEmbedColor(snapshot.overall))
        .setDescription(clampDescription(description));

    const fields = groups.map((group) => {
        const up = countUp(group.services);
        const down = countDown(group.services);

        let statusText = `${getStatusDot(group.status)} ${up}/${group.services.length}`;
        if (down > 0) {
            statusText += ` • **${down}** ${translation.trans('messages.status.down')}`;
        }

        return {
            name: nameOf(group.name, snapshot, locale),
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
        description += `**${getStatusDot(group.status)} ${nameOf(group.name, snapshot, locale)}**\n`;

        group.services.forEach((service) => {
            const dot = getStatusDot(service.status === STATUS.OPERATIONAL ? STATUS.OPERATIONAL : STATUS.MAJOR_OUTAGE);
            description += `    ${dot} ${nameOf(service.name, snapshot, locale)}\n`;
        });

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
        description += `**${nameOf(group.name, snapshot, locale)}**\n`;

        group.services.forEach((service) => {
            const dot = getStatusDot(service.status === STATUS.OPERATIONAL ? STATUS.OPERATIONAL : STATUS.MAJOR_OUTAGE);
            description += `${dot} ${nameOf(service.name, snapshot, locale)}\n`;
        });

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
