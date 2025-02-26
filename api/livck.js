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
        }).catch((error) => console.error('Error:', error));

        return response.json();
    }

    async get(path, query = {}, apiVersion = this.apiVersion) {
        return await this.request('GET', path, {}, query, apiVersion);
    }

}
