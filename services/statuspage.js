import logger from '../util/logger.js';

/**
 * Fetches and holds one status page's public data.
 *
 * Failures are NOT swallowed here any more. Returning empty collections on a network error
 * made an unreachable page look like an empty page, which is how the backoff in
 * services/statuspagePauseManager.js ended up unreachable code. Callers decide.
 */
export default class Statuspage {
    constructor(livck) {
        this.livck = livck;
        this.categories = [];
        this.alerts = [];
    }

    /**
     * The categories endpoint answers with an OBJECT keyed by category UUID, not an array —
     * a long-standing quirk of the self-hosted v3 API. Both shapes are accepted so a future
     * change on that side cannot break the bot.
     */
    static normalizeCategories(response) {
        const data = response?.data ?? response;

        if (Array.isArray(data)) return data;
        if (!data || typeof data !== 'object') return [];

        // An error payload can arrive as `{data: []}`; its values are arrays, not categories.
        const values = Object.values(data);
        if (values.length === 0 || Array.isArray(values[0])) return [];

        return values.filter((entry) => entry && typeof entry === 'object');
    }

    async fetchCategories() {
        const response = await this.livck.get('categories', { perPage: 100 });
        const categories = Statuspage.normalizeCategories(response);

        logger.debug(`[Statuspage] ${this.livck.baseURL}: ${categories.length} categories`);

        this.categories = await Promise.all(
            categories.map(async (category) => ({
                ...category,
                monitors: await this.categoryMonitors(category.id),
            }))
        );

        return this.categories;
    }

    async fetchAlerts(all = false) {
        const response = await this.livck.get('alerts', { perPage: 100, all }, 'v1');
        this.alerts = response?.data ?? [];
        return this.alerts;
    }

    async categoryMonitors(categoryId) {
        const response = await this.livck.get(`category/${categoryId}/monitors`, { perPage: 100 });
        return response?.data ?? [];
    }

    async fetchAll() {
        await Promise.all([
            this.fetchCategories(),
            this.fetchAlerts(),
        ]);
    }
}
