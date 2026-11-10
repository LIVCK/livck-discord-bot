/**
 * discord/restPolicy.js: which waits the client may sit out, and what gets logged.
 */

import { createRestPolicy } from '../../discord/restPolicy.js';

const URL = 'https://discord.com/api/v10/channels/123/messages';

/** What @discordjs/rest hands its `response` listeners. */
const respond = (policy, rest, status, body = {}) => rest.emit(
    { method: 'POST', path: '/channels/123/messages' },
    { status, json: async () => body },
);

const fakeRest = () => {
    const listeners = [];
    return {
        on: (event, fn) => { if (event === 'response') listeners.push(fn); },
        emit: (...args) => listeners.forEach((fn) => fn(...args)),
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
    test('names status, route and Discord code, most frequent first', async () => {
        const lines = [];
        const policy = createRestPolicy({ log: (line) => lines.push(line) });
        const rest = fakeRest();
        policy.attach(rest);

        respond(policy, rest, 403, { code: 50013 });
        respond(policy, rest, 403, { code: 50013 });
        respond(policy, rest, 429, {});
        respond(policy, rest, 200, {});
        await new Promise((resolve) => setImmediate(resolve));

        policy.summarize();
        policy.stop();

        expect(lines).toEqual([
            '[Discord] 3 refused request(s) in the last minute: ' +
            '403 POST /channels/123/messages (50013) ×2, 429 POST /channels/123/messages ×1',
        ]);
    });

    test('says nothing when nothing was refused', () => {
        const lines = [];
        const policy = createRestPolicy({ log: (line) => lines.push(line) });

        expect(policy.summarize()).toBeNull();
        expect(lines).toEqual([]);
    });
});
