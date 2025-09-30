export default class Statuspage {
    constructor(livck) {
        this.livck = livck;
        this.categories = {};
        this.alerts = {};
    }

    async fetchCategories() {
        try {
            const response = await this.livck.get('categories', {perPage: 100});
            const categoriesArray = response.data || [];

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
