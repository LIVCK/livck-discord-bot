/**
 * discord/restPolicy.js: which waits the client may sit out, and what gets logged.
 */

import { createRestPolicy } from '../../discord/restPolicy.js';

const URL = 'https://discord.com/api/v10/channels/123/messages';

/**
 * What @discordjs/rest hands its `response` listeners: a shallow copy sharing the body stream
 * with the request still in progress. Touching the body breaks that request, so here it throws.
 */
const respond = (policy, rest, status) => rest.emit(
    { method: 'POST', path: '/channels/123/messages' },
    {
        status,
        json: () => { throw new Error('the listener read the body'); },
        text: () => { throw new Error('the listener read the body'); },
        get body() { throw new Error('the listener touched the body'); },
    },
);

const fakeRest = () => {
    const listeners = { response: [], rateLimited: [] };
    return {
        on: (event, fn) => { listeners[event]?.push(fn); },
        emit: (...args) => listeners.response.forEach((fn) => fn(...args)),
        waited: (info) => listeners.rateLimited.forEach((fn) => fn(info)),
    };
};

describe('rejectOnRateLimit', () => {
    test('a 429 that Discord actually sent is final', () => {
        const policy = createRestPolicy({ log: () => {} });
        const rest = fakeRest();
        policy.attach(rest);

        respond(policy, rest, 429);

        expect(policy.options.rejectOnRateLimit({ method: 'post', url: URL, timeToReset: 250 })).toBe(true);
        policy.stop();
    });

    test('a wait the client predicted itself is sat out', () => {
        const policy = createRestPolicy({ log: () => {} });

        expect(policy.options.rejectOnRateLimit({ method: 'post', url: URL, timeToReset: 4000 })).toBe(false);
    });

    test('a predicted wait that long is not', () => {
        const policy = createRestPolicy({ log: () => {} });

        expect(policy.options.rejectOnRateLimit({ method: 'post', url: URL, timeToReset: 120_000 })).toBe(true);
    });

    test('a 429 on one route does not reject another', () => {
        const policy = createRestPolicy({ log: () => {} });
        const rest = fakeRest();
        policy.attach(rest);

        respond(policy, rest, 429);

        expect(policy.options.rejectOnRateLimit({
            method: 'patch', url: 'https://discord.com/api/v10/channels/123/messages/9', timeToReset: 250,
        })).toBe(false);
        policy.stop();
    });

    test('answering a slash command is left to the library', () => {
        const policy = createRestPolicy({ log: () => {} });

        expect(policy.options.rejectOnRateLimit({
            method: 'post',
            url: 'https://discord.com/api/v10/interactions/1/token/callback',
            timeToReset: 120_000,
        })).toBe(false);
    });
});

describe('the refused-request summary', () => {
    test('names status and route, most frequent first, without reading the body', async () => {
        const lines = [];
        const policy = createRestPolicy({ log: (line) => lines.push(line) });
        const rest = fakeRest();
        policy.attach(rest);

        respond(policy, rest, 403);
        respond(policy, rest, 403);
        respond(policy, rest, 429);
        respond(policy, rest, 200);
        await new Promise((resolve) => setImmediate(resolve));

        policy.summarize();
        policy.stop();

        expect(lines).toEqual([
            '[Discord] 3 refused request(s) in the last minute: ' +
            '403 POST /channels/123/messages ×2, 429 POST /channels/123/messages ×1',
        ]);
    });

    test('waits the client sat out are counted, not logged one by one', () => {
        // discord.js emits rateLimited once per wait, per bucket. A heartbeat over a few
        // hundred channels at once wrote a line for every one of them.
        const lines = [];
        const policy = createRestPolicy({ log: (line) => lines.push(line) });
        const rest = fakeRest();
        policy.attach(rest);

        rest.waited({ global: false, route: '/channels/:id/messages', timeToReset: 4000 });
        rest.waited({ global: false, route: '/channels/:id/messages', timeToReset: 1000 });
        rest.waited({ global: true, route: '/channels/:id/messages/:id', timeToReset: 300 });

        policy.summarize();
        policy.stop();

        expect(lines).toEqual([
            '[Discord] Waited for rate limits 3 time(s) in the last minute: ' +
            '/channels/:id/messages ×2 (up to 4.0s), global ×1 (up to 0.3s)',
        ]);
    });

    test('says nothing when nothing was refused', () => {
        const lines = [];
        const policy = createRestPolicy({ log: (line) => lines.push(line) });

        expect(policy.summarize()).toBeNull();
        expect(lines).toEqual([]);
    });
});
