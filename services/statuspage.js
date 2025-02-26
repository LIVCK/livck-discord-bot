export default class Statuspage {
    constructor(livck) {
        this.livck = livck;
        this.categories = {};
        this.alerts = {};
    }

    async fetchCategories() {
        const categories = await this.livck.get('categories', {perPage: 100}).catch((error) => this.catchErrors(error));
        this.categories = await Promise.all(
            Object.values(categories).map(async (category) => ({
                ...category,
                monitors: await this.categoryMonitors(category.id)
            }))
        );
    }

    async fetchAlerts(all = false) {
        this.alerts = await this.livck.get('alerts', {perPage: 100, all}, 'v1').catch((error) => this.catchErrors(error))
            .then((res) => res.data);
    }

    async categoryMonitors(categoryId) {
        return await this.livck.get(`category/${categoryId}/monitors`, {perPage: 100})
            .catch((error) => this.catchErrors(error))
            .then((res) => res.data);
    }

    async fetchAll() {
        await this.fetchCategories();
        await this.fetchAlerts();
    }

    catchErrors(error) {
        console.error('Error:', error);
    }
}
