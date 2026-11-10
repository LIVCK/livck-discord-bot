/**
 * How the bot's REST client treats Discord saying "not now".
 *
 * TWO DEFAULTS IN @discordjs/rest THAT DO NOT FIT A BOT LIKE THIS ONE
 *
 * 1. A 429 is retried for ever. The client sleeps for `retry_after` and sends the request
 *    again, as often as Discord answers 429, and the caller's promise does not settle in
 *    between. It does not emit `rateLimited` for this either (that event is only for waits it
 *    predicted itself), so it never appeared in the log. Each of those 429s counts towards
 *    Discord's invalid request limit, which is what the recurring INVALID REQUEST WARNING in
 *    production was counting.
 *
 *    Here a real 429 is final: the request fails with a RateLimitError and the subscription's
 *    backoff in util/delivery.js decides when to try that channel again. Waiting the bot
 *    predicted itself from the bucket headers is still allowed, up to MAX_WAIT_MS — that is
 *    how a burst of replies to one thread is spaced out, and it costs no invalid requests.
 *
 * 2. Nothing says which requests are refused. discord.js warns every 250 invalid requests
 *    with a count and nothing else. The `response` listener below collects 401/403/429 by
 *    route and Discord error code and writes one line per minute while there are any, so the
 *    channel behind a warning can be found from the log. Waits the client predicted itself
 *    (`rateLimited`) go into the same summary: discord.js emits one per bucket that has to
 *    wait, and a heartbeat across a few hundred channels used to write a line for each.
 */

/**
 * The longest predicted wait the client may sit out by itself.
 *
 * Generous on purpose. A predicted wait costs no invalid requests, and the delivery deadline in
 * util/delivery.js already decides how long the HANDLER waits — the request simply finishes in
 * the background, with the subscription held until it does. Five messages per five seconds per
 * channel means an incident with half a dozen updates needs one such wait to arrive whole, and
 * refusing it would turn the sixth message into a failure and a thirty-second backoff.
 */
const MAX_WAIT_MS = Number(process.env.DISCORD_MAX_RATE_LIMIT_WAIT_MS || 30_000);
const SUMMARY_INTERVAL_MS = 60_000;

/** `/channels/123/messages` from a full request URL, whatever the API base is. */
const pathOf = (url) => {
    try {
        return new URL(url).pathname.replace(/^.*?\/v\d+(?=\/)/, '');
    } catch {
        return String(url);
    }
};

const keyOf = (method, path) => `${String(method).toUpperCase()} ${path}`;

/**
 * @param {{log?: (line: string) => void}} [options]
 */
export const createRestPolicy = ({ log = (line) => console.warn(line) } = {}) => {
    /** request key → when Discord last answered it with a 429 */
    const tooMany = new Map();
    /** `${status} ${METHOD} ${path} ${code}` → count since the last summary */
    const refused = new Map();
    /** `global` or the bucket route → { count, longest } since the last summary */
    const waited = new Map();

    const rejectOnRateLimit = (data) => {
        const path = pathOf(data.url);

        // Only deliveries to channels. Answering a slash command goes through /interactions
        // and /webhooks, nothing there retries it on the bot's behalf, and an admin waiting on
        // a reply is better served by the library's own wait than by an error.
        if (!path.startsWith('/channels/')) return false;

        const key = keyOf(data.method, path);
        const answeredAt = tooMany.get(key);

        if (answeredAt !== undefined && Date.now() - answeredAt < 5000) {
            tooMany.delete(key);
            return true;
        }

        return data.timeToReset > MAX_WAIT_MS;
    };

    const onResponse = (request, response) => {
        const status = response.status;
        if (status !== 401 && status !== 403 && status !== 429) return;

        // Only where rejectOnRateLimit reads it. Interaction and webhook paths carry a token
        // each, so remembering them would only ever add entries.
        if (status === 429 && request.path.startsWith('/channels/')) {
            tooMany.set(keyOf(request.method, request.path), Date.now());
        }

        // The body names the reason (50013, 50001, …); reading it is asynchronous and the
        // response handed to listeners is a clone, so it costs the request nothing.
        const count = (code) => {
            const key = `${status} ${keyOf(request.method, request.path)}${code ? ` (${code})` : ''}`;
            refused.set(key, (refused.get(key) ?? 0) + 1);
        };
        Promise.resolve(typeof response.json === 'function' ? response.json() : null)
            .then((body) => count(body?.code), () => count(null));
    };

    const onRateLimited = (info) => {
        const key = info.global ? 'global' : info.route;
        const entry = waited.get(key) ?? { count: 0, longest: 0 };
        entry.count += 1;
        entry.longest = Math.max(entry.longest, Number(info.timeToReset) || 0);
        waited.set(key, entry);
    };

    const summarizeWaits = () => {
        if (waited.size === 0) return null;

        const entries = [...waited.entries()].sort((a, b) => b[1].count - a[1].count);
        const total = entries.reduce((sum, [, { count }]) => sum + count, 0);
        waited.clear();

        const top = entries.slice(0, 8)
            .map(([key, { count, longest }]) => `${key} ×${count} (up to ${(longest / 1000).toFixed(1)}s)`)
            .join(', ');
        const more = entries.length > 8 ? `, and ${entries.length - 8} more` : '';
        const line = `[Discord] Waited for rate limits ${total} time(s) in the last minute: ${top}${more}`;
        log(line);
        return line;
    };

    const summarize = () => {
        const waits = summarizeWaits();
        if (refused.size === 0) return waits;

        const entries = [...refused.entries()].sort((a, b) => b[1] - a[1]);
        const total = entries.reduce((sum, [, n]) => sum + n, 0);
        refused.clear();

        const top = entries.slice(0, 8).map(([key, n]) => `${key} ×${n}`).join(', ');
        const more = entries.length > 8 ? `, and ${entries.length - 8} more` : '';
        const line = `[Discord] ${total} refused request(s) in the last minute: ${top}${more}`;
        log(line);
        return line;
    };

    let timer = null;

    return {
        /** Spread into `new Client({ rest: { ... } })`. */
        options: {
            rejectOnRateLimit,
            // Emit invalidRequestWarning every N invalid responses instead of never (the
            // default of 0 disables the warning entirely). 250 gives ~40 warnings before the
            // 10,000 ban threshold, which is early enough to react and rare enough to read.
            invalidRequestWarningInterval: 250,
        },

        /** Start listening on a client's REST manager. */
        attach(rest) {
            rest.on('response', onResponse);
            rest.on('rateLimited', onRateLimited);
            timer = setInterval(summarize, SUMMARY_INTERVAL_MS);
            timer.unref?.();
            return this;
        },

        stop() {
            if (timer) clearInterval(timer);
            timer = null;
        },

        /** For tests: write the pending summary now. */
        summarize,
    };
};

export default createRestPolicy;
