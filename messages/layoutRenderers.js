import { EmbedBuilder } from "discord.js";
import translation from "../util/Translation.js";
import { getStatusDot } from "../config/emojis.js";
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
        case 'AVAILABLE':
            return '<a:status_up:1344187859921535047>';
        case 'UNAVAILABLE':
            return '<a:status_down:1344187930499088394>';
        default:
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
        case 'AVAILABLE':
            return 0x2ecc71; // Green
        case 'UNAVAILABLE':
            return 0xe74c3c; // Red
        case 'DEGRADED':
            return 0xf39c12; // Yellow/Orange
        default:
            return 0x95a5a6; // Gray
    }
};

/**
 * Calculate overall status for a category
 * @param {Array} monitors - Array of monitors
 * @returns {string} Overall status (AVAILABLE, UNAVAILABLE, or DEGRADED)
 */
const getCategoryStatus = (monitors) => {
    if (!monitors || monitors.length === 0) return 'AVAILABLE';

    const hasUnavailable = monitors.some(m => m.state === 'UNAVAILABLE');
    const allAvailable = monitors.every(m => m.state === 'AVAILABLE');

    if (allAvailable) return 'AVAILABLE';
    if (hasUnavailable) return 'UNAVAILABLE';
    return 'DEGRADED';
};

/**
 * Calculate overall status across all categories
 * RED: All monitors down
 * YELLOW: Some monitors down (partial outage)
 * GREEN: All monitors up
 *
 * @param {Array} categories - Array of categories with monitors
 * @returns {string} Overall status (AVAILABLE, UNAVAILABLE, or DEGRADED)
 */
const getOverallStatus = (categories) => {
    if (!categories || categories.length === 0) return 'AVAILABLE';

    // Collect all monitors across all categories
    const allMonitors = categories.reduce((acc, cat) => {
        const monitors = Array.isArray(cat.monitors) ? cat.monitors : [];
        return acc.concat(monitors);
    }, []);

    if (allMonitors.length === 0) return 'AVAILABLE';

    const availableCount = allMonitors.filter(m => m.state === 'AVAILABLE').length;
    const totalCount = allMonitors.length;

    // GREEN: All monitors operational
    if (availableCount === totalCount) return 'AVAILABLE';

    // RED: All monitors down
    if (availableCount === 0) return 'UNAVAILABLE';

    // YELLOW: Partial outage (some down, some up)
    return 'DEGRADED';
};

/**
 * Get category status emoji
 * @param {string} status - Category status
 * @returns {string} Status emoji
 */
const getCategoryStatusEmoji = (status) => {
    switch (status) {
        case 'AVAILABLE':
            return '✅';
        case 'UNAVAILABLE':
            return '❌';
        case 'DEGRADED':
            return '⚠️';
        default:
            return '❔';
    }
};

/**
 * Detailed Layout - Shows all monitors grouped by categories
 * This is the default layout with full monitor details
 *
 * @param {Object} statuspageService - Statuspage service instance
 * @param {Object} statuspage - Statuspage record
 * @param {string} locale - User's locale
 * @returns {Array<Object>} Array with single embed (for consistency with other layouts)
 */
export const renderDetailedLayout = (statuspageService, statuspage, locale = 'de') => {
    translation.setLocale(locale);

    const categories = statuspageService.categories || [];

    if (categories.length === 0) {
        return [{
            embed: new EmbedBuilder()
                .setTitle(translation.trans('messages.status.title', { name: statuspage.name }))
                .setDescription(translation.trans('messages.status.no_categories'))
                .setURL(statuspage.url)
                .setTimestamp(new Date())
                .setFooter({ text: statuspage.name }),
            type: 'single'
        }];
    }

    // Calculate overall status for embed color
    const overallStatus = getOverallStatus(categories);
    const embedColor = getEmbedColor(overallStatus);

    const fields = categories.map((category) => {
        const monitors = Array.isArray(category.monitors) ? category.monitors : [];
        const monitorList = serviceLines(
            monitors.map((monitor) => {
                const emoji = getStatusEmoji(monitor.state);
                return `${emoji} **${monitor.name}**`;
            })
        ) || translation.trans('messages.status.no_services');

        return {
            name: category.name || translation.trans('messages.status.unknown_category'),
            value: monitorList,
            inline: false // Default layout - full width, straight down
        };
    });

    const embed = new EmbedBuilder()
        .setTitle(translation.trans('messages.status.title', { name: statuspage.name }))
        .setColor(embedColor)
        .setURL(statuspage.url)
        .setTimestamp(new Date())
        .setFooter({ text: statuspage.name });

    finalizeEmbed(embed, fields);

    return [{ embed, type: 'single' }];
};

/**
 * Compact Layout - Shows monitors in a condensed format with status counts
 * Shows category status and count instead of listing all monitors
 *
 * @param {Object} statuspageService - Statuspage service instance
 * @param {Object} statuspage - Statuspage record
 * @param {string} locale - User's locale
 * @returns {Array<Object>} Array with single embed
 */
export const renderCompactLayout = (statuspageService, statuspage, locale = 'de') => {
    translation.setLocale(locale);

    const categories = statuspageService.categories || [];

    if (categories.length === 0) {
        return [{
            embed: new EmbedBuilder()
                .setTitle(translation.trans('messages.status.title', { name: statuspage.name }))
                .setDescription(translation.trans('messages.status.no_categories'))
                .setURL(statuspage.url)
                .setTimestamp(new Date())
                .setFooter({ text: statuspage.name }),
            type: 'single'
        }];
    }

    // Calculate overall status for embed color
    const overallStatus = getOverallStatus(categories);
    const embedColor = getEmbedColor(overallStatus);

    const fields = categories.map((category, index) => {
        const monitors = Array.isArray(category.monitors) ? category.monitors : [];
        const categoryStatus = getCategoryStatus(monitors);

        // Count by status
        const availableCount = monitors.filter(m => m.state === 'AVAILABLE').length;
        const unavailableCount = monitors.filter(m => m.state === 'UNAVAILABLE').length;
        const totalCount = monitors.length;

        // Status indicator with custom emoji dot
        const statusDot = getStatusDot(categoryStatus);
        let statusLabel;
        if (categoryStatus === 'AVAILABLE') {
            statusLabel = translation.trans('messages.status.operational');
        } else if (categoryStatus === 'UNAVAILABLE') {
            statusLabel = translation.trans('messages.status.critical');
        } else {
            statusLabel = translation.trans('messages.status.degraded');
        }

        let statusText = `┃ **${availableCount}/${totalCount}** ${translation.trans('messages.status.services')}`;
        if (unavailableCount > 0) {
            statusText += `\n┗━ ${statusDot} **${unavailableCount}** ${translation.trans('messages.status.down')}`;
        } else {
            statusText += `\n┗━ ${statusDot} ${statusLabel}`;
        }

        return {
            name: category.name || translation.trans('messages.status.unknown_category'),
            value: statusText || translation.trans('messages.status.no_services'),
            inline: true
        };
    });

    const embed = new EmbedBuilder()
        .setTitle(translation.trans('messages.status.title', { name: statuspage.name }))
        .setColor(embedColor)
        .setURL(statuspage.url)
        .setTimestamp(new Date())
        .setFooter({ text: statuspage.name });

    finalizeEmbed(embed, fields, { inline: true });

    return [{ embed, type: 'single' }];
};

/**
 * Overview Layout - Shows only categories with overall status
 * Useful for high-level monitoring without monitor details
 *
 * @param {Object} statuspageService - Statuspage service instance
 * @param {Object} statuspage - Statuspage record
 * @param {string} locale - User's locale
 * @returns {Array<Object>} Array with single embed
 */
export const renderOverviewLayout = (statuspageService, statuspage, locale = 'de') => {
    translation.setLocale(locale);

    const categories = statuspageService.categories || [];

    if (categories.length === 0) {
        return [{
            embed: new EmbedBuilder()
                .setTitle(translation.trans('messages.status.title', { name: statuspage.name }))
                .setDescription(translation.trans('messages.status.no_categories'))
                .setURL(statuspage.url)
                .setTimestamp(new Date())
                .setFooter({ text: statuspage.name }),
            type: 'single'
        }];
    }

    // Calculate overall status for embed color and summary
    const overallStatus = getOverallStatus(categories);
    const embedColor = getEmbedColor(overallStatus);

    // Calculate totals for description
    const totalMonitors = categories.reduce((sum, cat) => {
        const monitors = Array.isArray(cat.monitors) ? cat.monitors : [];
        return sum + monitors.length;
    }, 0);

    const totalAvailable = categories.reduce((sum, cat) => {
        const monitors = Array.isArray(cat.monitors) ? cat.monitors : [];
        return sum + monitors.filter(m => m.state === 'AVAILABLE').length;
    }, 0);

    const totalUnavailable = totalMonitors - totalAvailable;
    const overallPercentage = totalMonitors > 0 ? Math.round((totalAvailable / totalMonitors) * 100) : 100;

    // Create overall status indicator
    const overallStatusDot = getStatusDot(overallStatus);
    let statusSummary;
    if (overallStatus === 'AVAILABLE') {
        statusSummary = `${overallStatusDot} ${translation.trans('messages.status.all_systems_operational')}`;
    } else if (overallStatus === 'UNAVAILABLE') {
        statusSummary = `${overallStatusDot} ${translation.trans('messages.status.system_issues_detected')}`;
    } else {
        statusSummary = `${overallStatusDot} ${translation.trans('messages.status.partial_degradation')}`;
    }

    // Create description with clean status summary
    let description = `${statusSummary}`;
    if (totalUnavailable > 0) {
        description += `\n\`\`\`diff\n- ${totalUnavailable} ${translation.trans('messages.status.services')} ${translation.trans('messages.status.down')}\n+ ${totalAvailable} ${translation.trans('messages.status.services')} ${translation.trans('messages.status.operational')}\n\`\`\``;
    } else {
        description += `\n\`\`\`diff\n+ ${totalAvailable}/${totalMonitors} ${translation.trans('messages.status.services')} ${translation.trans('messages.status.operational')}\n\`\`\``;
    }

    // Build fields for each category with cleaner layout
    const fields = categories.map((category) => {
        const monitors = Array.isArray(category.monitors) ? category.monitors : [];
        const categoryStatus = getCategoryStatus(monitors);
        const categoryName = category.name || translation.trans('messages.status.unknown_category');

        // Count monitors by status
        const totalMonitors = monitors.length;
        const availableCount = monitors.filter(m => m.state === 'AVAILABLE').length;
        const unavailableCount = monitors.filter(m => m.state === 'UNAVAILABLE').length;

        // Use custom emoji dots
        const statusDot = getStatusDot(categoryStatus);

        // Build clean status line
        let statusText = `${statusDot} ${availableCount}/${totalMonitors}`;
        if (unavailableCount > 0) {
            statusText += ` • **${unavailableCount}** ${translation.trans('messages.status.down')}`;
        }

        return {
            name: categoryName,
            value: statusText,
            inline: true
        };
    });

    const embed = new EmbedBuilder()
        .setTitle(translation.trans('messages.status.title', { name: statuspage.name }))
        .setDescription(clampDescription(description))
        .setColor(embedColor)
        .setURL(statuspage.url)
        .setTimestamp(new Date())
        .setFooter({ text: statuspage.name });

    finalizeEmbed(embed, fields, { inline: true });

    return [{ embed, type: 'single' }];
};

/**
 * Tree Layout - Shows categories and services in a hierarchical tree structure
 * Uses visual separators between categories for better readability
 *
 * @param {Object} statuspageService - Statuspage service instance
 * @param {Object} statuspage - Statuspage record
 * @param {string} locale - User's locale
 * @returns {Array<Object>} Array with single embed
 */
export const renderTreeLayout = (statuspageService, statuspage, locale = 'de') => {
    translation.setLocale(locale);

    const categories = statuspageService.categories || [];

    if (categories.length === 0) {
        return [{
            embed: new EmbedBuilder()
                .setTitle(translation.trans('messages.status.title', { name: statuspage.name }))
                .setDescription(translation.trans('messages.status.no_categories'))
                .setURL(statuspage.url)
                .setTimestamp(new Date())
                .setFooter({ text: statuspage.name }),
            type: 'single'
        }];
    }

    // Calculate overall status
    const overallStatus = getOverallStatus(categories);
    const embedColor = getEmbedColor(overallStatus);

    // Build tree as description with better formatting
    let description = '';

    categories.forEach((category, catIndex) => {
        const monitors = Array.isArray(category.monitors) ? category.monitors : [];
        const categoryName = category.name || translation.trans('messages.status.unknown_category');
        const categoryStatus = getCategoryStatus(monitors);
        const categoryDot = getStatusDot(categoryStatus);

        // Add category header with bold text
        description += `**${categoryDot} ${categoryName}**\n`;

        // Add monitors under category with indentation
        monitors.forEach((monitor, monIndex) => {
            const monitorDot = getStatusDot(monitor.state === 'AVAILABLE' ? 'AVAILABLE' : 'UNAVAILABLE');
            description += `    ${monitorDot} ${monitor.name}\n`;
        });

        // Add visual separator between categories (except last one)
        if (catIndex < categories.length - 1) {
            description += '\n';
        }
    });

    const embed = new EmbedBuilder()
        .setTitle(translation.trans('messages.status.title', { name: statuspage.name }))
        .setDescription(clampDescription(description))
        .setColor(embedColor)
        .setURL(statuspage.url)
        .setTimestamp(new Date())
        .setFooter({ text: statuspage.name });

    return [{ embed, type: 'single' }];
};

/**
 * Minimal Layout - Ultra-clean display with only status dots and names
 * No counts, no extra info - just pure status overview
 *
 * @param {Object} statuspageService - Statuspage service instance
 * @param {Object} statuspage - Statuspage record
 * @param {string} locale - User's locale
 * @returns {Array<Object>} Array with single embed
 */
export const renderMinimalLayout = (statuspageService, statuspage, locale = 'de') => {
    translation.setLocale(locale);

    const categories = statuspageService.categories || [];

    if (categories.length === 0) {
        return [{
            embed: new EmbedBuilder()
                .setTitle(translation.trans('messages.status.title', { name: statuspage.name }))
                .setDescription(translation.trans('messages.status.no_categories'))
                .setURL(statuspage.url)
                .setTimestamp(new Date())
                .setFooter({ text: statuspage.name }),
            type: 'single'
        }];
    }

    // Calculate overall status
    const overallStatus = getOverallStatus(categories);
    const embedColor = getEmbedColor(overallStatus);

    // Build description with minimal formatting
    let description = '';

    categories.forEach((category, catIndex) => {
        const monitors = Array.isArray(category.monitors) ? category.monitors : [];
        const categoryName = category.name || translation.trans('messages.status.unknown_category');

        // Category name without status indicator
        description += `**${categoryName}**\n`;

        // Just monitor name with dot - nothing else
        monitors.forEach((monitor) => {
            const monitorDot = getStatusDot(monitor.state === 'AVAILABLE' ? 'AVAILABLE' : 'UNAVAILABLE');
            description += `${monitorDot} ${monitor.name}\n`;
        });

        // Single line break between categories
        if (catIndex < categories.length - 1) {
            description += '\n';
        }
    });

    const embed = new EmbedBuilder()
        .setTitle(translation.trans('messages.status.title', { name: statuspage.name }))
        .setDescription(clampDescription(description))
        .setColor(embedColor)
        .setURL(statuspage.url)
        .setTimestamp(new Date())
        .setFooter({ text: statuspage.name });

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
