export default class Statuspage {
    constructor(livck) {
        this.livck = livck;
        this.categories = {};
        this.alerts = {};
    }

    async fetchCategories() {
        try {
            console.log('[Statuspage] Fetching categories from:', this.livck.baseURL);
            const response = await this.livck.get('categories', {perPage: 100});
            console.log('[Statuspage] Categories response:', response);

            // Handle both object and array responses
            // The API returns data either in response.data or directly in response
            let categoriesData = response.data || response;
            let categoriesArray = [];

            if (Array.isArray(categoriesData)) {
                categoriesArray = categoriesData;
            } else if (typeof categoriesData === 'object' && categoriesData !== null) {
                // Convert object to array (skip empty arrays returned on error)
                const values = Object.values(categoriesData);
                if (values.length > 0 && !Array.isArray(values[0])) {
                    categoriesArray = values;
                }
            }

            console.log('[Statuspage] Categories array:', categoriesArray.length);

            this.categories = await Promise.all(
                categoriesArray.map(async (category) => ({
                    ...category,
                    monitors: await this.categoryMonitors(category.id)
                }))
            );
        } catch (error) {
            console.error('[Statuspage] Error fetching categories:', error);
            this.categories = [];
        }
    }

    async fetchAlerts(all = false) {
        try {
            const response = await this.livck.get('alerts', {perPage: 100, all}, 'v1');
            this.alerts = response.data || [];
        } catch (error) {
            console.error('[Statuspage] Error fetching alerts:', error);
            this.alerts = [];
        }
    }

    async categoryMonitors(categoryId) {
        try {
            const response = await this.livck.get(`category/${categoryId}/monitors`, {perPage: 100});
            return response.data || [];
        } catch (error) {
            console.error(`[Statuspage] Error fetching monitors for category ${categoryId}:`, error);
            return [];
        }
    }

    async fetchAll() {
        await Promise.all([
            this.fetchCategories(),
            this.fetchAlerts()
        ]);
    }

    catchErrors(error) {
        console.error('Error:', error);
        return { data: [] };
    }

}
