export const normalizeUrl = (url, ignorePath = false) => {
    if (!url) {
        return null;
    }

    try {
        if (!url.startsWith('http')) // Enforce HTTPS by no protocol
            url = `https://${url}`;

        const parsedUrl = new URL(url);

        // `host`, not `hostname`: a status page on its own port (`https://status.example.com:8443`)
        // was subscribed as the same host without it — a different server, or none. A default
        // port is not part of `host`, so every URL without an explicit port is unchanged.
        let normalized = `${parsedUrl.protocol}//${parsedUrl.host}${ignorePath ? '' : parsedUrl.pathname}`;

        if (normalized.endsWith('/')) {
            normalized = normalized.slice(0, -1);
        }

        normalized = normalized.toLowerCase();

        return normalized;
    } catch (error) {
        throw new Error(`Wrong URL: ${url}`);
    }
};

export const domainFromUrl = (url) => {
    try {
        const parsedUrl = new URL(url);
        return parsedUrl.hostname;
    } catch (error) {
        throw new Error(`Wrong URL: ${url}`);
    }
}

export const truncate = (text, length = 500) => {
    if (text.length > length) {
        return `${text.substring(0, length)}...`;
    }

    return text;
}
