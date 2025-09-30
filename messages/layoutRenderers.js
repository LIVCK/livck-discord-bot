import { EmbedBuilder } from "discord.js";
import translation from "../util/Translation.js";

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
 * @param {Array} categories - Array of categories with monitors
 * @returns {string} Overall status (AVAILABLE, UNAVAILABLE, or DEGRADED)
 */
const getOverallStatus = (categories) => {
    if (!categories || categories.length === 0) return 'AVAILABLE';

    const categoryStatuses = categories.map(cat => {
        const monitors = Array.isArray(cat.monitors) ? cat.monitors : [];
        return getCategoryStatus(monitors);
    });

    const hasUnavailable = categoryStatuses.includes('UNAVAILABLE');
    const hasDegraded = categoryStatuses.includes('DEGRADED');
    const allAvailable = categoryStatuses.every(status => status === 'AVAILABLE');

    if (allAvailable) return 'AVAILABLE';
    if (hasUnavailable) return 'UNAVAILABLE';
    if (hasDegraded) return 'DEGRADED';
    return 'AVAILABLE';
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
        const monitorList = monitors
            .map((monitor) => {
                const emoji = getStatusEmoji(monitor.state);
                return `${emoji} **${monitor.name}**`;
            })
            .join('\n') || translation.trans('messages.status.no_services');

        return {
            name: category.name || translation.trans('messages.status.unknown_category'),
            value: monitorList,
            inline: false // Default layout - full width, straight down
        };
    });

    const embed = new EmbedBuilder()
        .setTitle(translation.trans('messages.status.title', { name: statuspage.name }))
        .setColor(embedColor)
        .setFields(fields)
        .setURL(statuspage.url)
        .setTimestamp(new Date())
        .setFooter({ text: statuspage.name });

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

        // Status bar using blocks
        const statusBar = '█'.repeat(availableCount) + (unavailableCount > 0 ? '▓'.repeat(unavailableCount) : '');
        const percentage = totalCount > 0 ? Math.round((availableCount / totalCount) * 100) : 100;

        let statusText = `\`${percentage}%\` ${statusBar}\n${availableCount}/${totalCount} operational`;
        if (unavailableCount > 0) {
            statusText += ` • ${unavailableCount} down`;
        }

        // Always inline for compact, max 2 per row
        const shouldBeInline = (index % 2 === 0 && index < categories.length - 1) || (index % 2 === 1);

        return {
            name: category.name || translation.trans('messages.status.unknown_category'),
            value: statusText || translation.trans('messages.status.no_services'),
            inline: shouldBeInline
        };
    });

    const embed = new EmbedBuilder()
        .setTitle(`📊 ${statuspage.name}`)
        .setColor(embedColor)
        .setFields(fields)
        .setURL(statuspage.url)
        .setTimestamp(new Date())
        .setFooter({ text: statuspage.name });

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

    // Calculate overall status for embed color
    const overallStatus = getOverallStatus(categories);
    const embedColor = getEmbedColor(overallStatus);

    // Build fields with visual status bars
    const fields = categories.map((category) => {
        const monitors = Array.isArray(category.monitors) ? category.monitors : [];
        const categoryStatus = getCategoryStatus(monitors);
        const categoryName = category.name || translation.trans('messages.status.unknown_category');

        // Count monitors by status
        const totalMonitors = monitors.length;
        const availableCount = monitors.filter(m => m.state === 'AVAILABLE').length;
        const unavailableCount = monitors.filter(m => m.state === 'UNAVAILABLE').length;

        // Create visual progress bar
        const percentage = totalMonitors > 0 ? Math.round((availableCount / totalMonitors) * 100) : 100;
        const filledBlocks = Math.round((availableCount / totalMonitors) * 10);
        const emptyBlocks = 10 - filledBlocks;

        let statusBar;
        if (categoryStatus === 'AVAILABLE') {
            statusBar = '🟩'.repeat(10);
        } else if (categoryStatus === 'UNAVAILABLE') {
            statusBar = '🟥'.repeat(emptyBlocks) + '⬜'.repeat(filledBlocks);
        } else {
            statusBar = '🟨'.repeat(emptyBlocks) + '🟩'.repeat(filledBlocks);
        }

        let statusText = `${statusBar}\n**${percentage}%** operational • ${availableCount}/${totalMonitors} services`;
        if (unavailableCount > 0) {
            statusText += `\n⚠️ ${unavailableCount} service${unavailableCount > 1 ? 's' : ''} down`;
        }

        return {
            name: `${getCategoryStatusEmoji(categoryStatus)} ${categoryName}`,
            value: statusText,
            inline: false
        };
    });

    const embed = new EmbedBuilder()
        .setTitle(`📊 ${statuspage.name} - Overview`)
        .setColor(embedColor)
        .setFields(fields)
        .setURL(statuspage.url)
        .setTimestamp(new Date())
        .setFooter({ text: statuspage.name });

    return [{ embed, type: 'single' }];
};

/**
 * Embed List Layout - Creates separate embeds for each category in 2-column grid
 * Maximum of 10 embeds due to Discord limitations
 *
 * @param {Object} statuspageService - Statuspage service instance
 * @param {Object} statuspage - Statuspage record
 * @param {string} locale - User's locale
 * @returns {Array<Object>} Array with multiple embeds
 */
export const renderEmbedListLayout = (statuspageService, statuspage, locale = 'de') => {
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
            type: 'multiple'
        }];
    }

    // Discord allows max 10 embeds per message
    const limitedCategories = categories.slice(0, 10);

    const embeds = limitedCategories.map((category, index) => {
        const monitors = Array.isArray(category.monitors) ? category.monitors : [];
        const categoryName = category.name || translation.trans('messages.status.unknown_category');
        const categoryStatus = getCategoryStatus(monitors);
        const statusEmoji = getCategoryStatusEmoji(categoryStatus);
        const embedColor = getEmbedColor(categoryStatus);

        // Build fields in 2-column grid
        const fields = monitors.map((monitor, monitorIndex) => {
            const emoji = getStatusEmoji(monitor.state);
            const shouldBeInline = (monitorIndex % 2 === 0 && monitorIndex < monitors.length - 1) || (monitorIndex % 2 === 1);

            return {
                name: monitor.name,
                value: `${emoji} ${monitor.state === 'AVAILABLE' ? 'Operational' : 'Down'}`,
                inline: shouldBeInline
            };
        });

        // If no monitors, show a message
        if (fields.length === 0) {
            fields.push({
                name: '\u200B',
                value: translation.trans('messages.status.no_services'),
                inline: false
            });
        }

        // Count stats for title
        const availableCount = monitors.filter(m => m.state === 'AVAILABLE').length;
        const totalCount = monitors.length;

        const embed = new EmbedBuilder()
            .setTitle(`${statusEmoji} ${categoryName}`)
            .setColor(embedColor)
            .setDescription(`**${availableCount}/${totalCount}** services operational`)
            .setFields(fields)
            .setURL(statuspage.url);

        // Add timestamp and footer on first embed only
        if (index === 0) {
            embed.setTimestamp(new Date());
            embed.setFooter({ text: statuspage.name });
        }

        return { embed, type: 'multiple' };
    });

    return embeds;
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
        case 'EMBED_LIST':
            return renderEmbedListLayout;
        default:
            return renderDetailedLayout; // Fallback to default
    }
};

export default {
    renderDetailedLayout,
    renderCompactLayout,
    renderOverviewLayout,
    renderEmbedListLayout,
    getLayoutRenderer,
    getStatusEmoji
};
