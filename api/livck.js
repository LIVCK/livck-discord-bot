export default class LIVCK {

    constructor(baseUrl = 'https://status.livck.com/api', apiVersion = 'v3') {
        this.baseURL = baseUrl;
        this.apiVersion = apiVersion;
    }

    build(path, version = this.apiVersion) {
        return `${this.baseURL}/api/${version}/${path}`;
    }

    async request(method, path, params = {}, query = {}, apiVersion = this.apiVersion) {
        const url = new URL(this.build(path, apiVersion));
        Object.entries(query).forEach(([key, value]) => url.searchParams.append(key, value));

        const response = await fetch(url.toString(), {
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            ...params
        }).catch((error) => {
            console.error('Error:', error);
            throw error;
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            throw new Error(`Expected JSON response, got: ${contentType}`);
        }

        return response.json();
    }

    async get(path, query = {}, apiVersion = this.apiVersion) {
        try {
            return await this.request('GET', path, {}, query, apiVersion);
        } catch (error) {
            if (error.message && error.message.includes('HTTP 403')) {
                console.warn(`[LIVCK] Access denied (403) for ${this.baseURL}: ${path}`);
            } else if (error.cause?.code === 'UND_ERR_CONNECT_TIMEOUT') {
                console.warn(`[LIVCK] Connection timeout for ${this.baseURL}: ${path}`);
            } else if (error.message && error.message.includes('fetch failed')) {
                console.warn(`[LIVCK] Network error for ${this.baseURL}: ${path}`);
            } else {
                console.error('Error:', error, { path, query, apiVersion, statuspage: this.baseURL });
            }
            return { data: [] };
        }
    }

    async ensureIsLIVCK() {
        const response = await fetch(this.baseURL).catch((error) => {
            console.error('Error [ensureIsLIVCK]:', error);
            return null;
        });

        if (!response) {
            return false;
        }

        return response.headers.has('lvk-version');
    }

}
