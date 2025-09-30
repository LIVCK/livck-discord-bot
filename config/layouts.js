/**
 * Layout Registry for Statuspage Messages
 *
 * This registry defines all available layouts for status page messages.
 * Each layout has a unique key, translation keys, and a renderer function.
 */

export const LAYOUT_REGISTRY = {
    /**
     * Detailed Layout (Default)
     * Shows all monitors grouped by categories with full details
     */
    DETAILED: {
        key: 'DETAILED',
        translationKey: 'detailed',
        description: 'Shows all monitors with status indicators',
        emoji: '📋',
        renderer: 'renderDetailedLayout'
    },

    /**
     * Compact Layout
     * Shows monitors in a more condensed format with inline status
     */
    COMPACT: {
        key: 'COMPACT',
        translationKey: 'compact',
        description: 'Compact view with inline status',
        emoji: '📑',
        renderer: 'renderCompactLayout'
    },

    /**
     * Overview Layout
     * Shows only categories with their overall status
     */
    OVERVIEW: {
        key: 'OVERVIEW',
        translationKey: 'overview',
        description: 'Shows only categories with overall status',
        emoji: '📊',
        renderer: 'renderOverviewLayout'
    },

    /**
     * Embed List Layout
     * Creates separate embeds for each category
     */
    EMBED_LIST: {
        key: 'EMBED_LIST',
        translationKey: 'embed_list',
        description: 'Separate embeds for each category',
        emoji: '📚',
        renderer: 'renderEmbedListLayout'
    }
};

/**
 * Get all available layouts as an array
 * @returns {Array} Array of layout objects
 */
export const getAvailableLayouts = () => {
    return Object.values(LAYOUT_REGISTRY);
};

/**
 * Get layout by key
 * @param {string} layoutKey - The layout key
 * @returns {Object|null} Layout object or null if not found
 */
export const getLayoutByKey = (layoutKey) => {
    return LAYOUT_REGISTRY[layoutKey] || null;
};

/**
 * Get default layout
 * @returns {Object} Default layout object
 */
export const getDefaultLayout = () => {
    return LAYOUT_REGISTRY.DETAILED;
};

/**
 * Validate layout key
 * @param {string} layoutKey - The layout key to validate
 * @returns {boolean} True if valid, false otherwise
 */
export const isValidLayout = (layoutKey) => {
    return layoutKey in LAYOUT_REGISTRY;
};

/**
 * Get layout keys as array (for database ENUM)
 * @returns {Array<string>} Array of layout keys
 */
export const getLayoutKeys = () => {
    return Object.keys(LAYOUT_REGISTRY);
};

export default LAYOUT_REGISTRY;
