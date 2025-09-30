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
        description: 'Complete list of all monitors',
        renderer: 'renderDetailedLayout'
    },

    /**
     * Compact Layout
     * Shows monitors in a condensed grid format with status counters
     */
    COMPACT: {
        key: 'COMPACT',
        translationKey: 'compact',
        description: 'Grid view with status counters',
        renderer: 'renderCompactLayout'
    },

    /**
     * Overview Layout
     * Shows categories with summary metrics and overall status
     */
    OVERVIEW: {
        key: 'OVERVIEW',
        translationKey: 'overview',
        description: 'Summary with key metrics',
        renderer: 'renderOverviewLayout'
    },

    // /**
    //  * Tree Layout
    //  * Shows hierarchical category structure with indented monitors
    //  */
    // TREE: {
    //     key: 'TREE',
    //     translationKey: 'tree',
    //     description: 'Hierarchical category structure',
    //     renderer: 'renderTreeLayout'
    // },

    /**
     * Minimal Layout
     * Ultra-clean display with only status dots and names
     */
    MINIMAL: {
        key: 'MINIMAL',
        translationKey: 'minimal',
        description: 'Clean status indicators only',
        renderer: 'renderMinimalLayout'
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
