/**
 * discord/gatewayWatch.js: a gateway that is gone for good is a reason to leave.
 *
 * The update loop talks to Discord over REST and keeps working without the gateway, so
 * nothing else notices when it is lost. Slash commands arrive over the gateway alone: the bot
 * stays up, posts status updates, and answers no /livck at all.
 */

import { EventEmitter } from 'events';
import { jest } from '@jest/globals';
import { Events, GatewayCloseCodes } from 'discord.js';
import { watchGateway } from '../../discord/gatewayWatch.js';

const setup = (options = {}) => {
    const client = new EventEmitter();
    const lines = [];
    const fatal = jest.fn();
    let now = 0;
    const watch = watchGateway(client, {
        onFatal: fatal,
        log: (level, line) => lines.push(`${level} ${line}`),
        now: () => now,
        stallMs: 60_000,
        graceMs: 10_000,
        checkEveryMs: 0,
        ...options,
    });
    return { client, lines, fatal, watch, advance: (ms) => { now += ms; watch.check(); } };
};

describe('a close Discord will not recover from', () => {
    test.each([
        ['AuthenticationFailed', GatewayCloseCodes.AuthenticationFailed],
        ['DisallowedIntents', GatewayCloseCodes.DisallowedIntents],
    ])('%s ends the process', (name, code) => {
        // discord.js emits shardDisconnect only for these, and never reconnects after one.
        const { client, lines, fatal } = setup();
        client.emit(Events.ClientReady);

        client.emit(Events.ShardDisconnect, { code }, 0);

        expect(fatal).toHaveBeenCalledWith(expect.stringContaining(name));
        expect(lines.join('\n')).toMatch(new RegExp(`error .*${code}.*${name}`));
    });

    test('and nothing claims it is still reconnecting afterwards', () => {
        // Seen against the real gateway: login with an intent that is not enabled answers 4014,
        // and the next check said "still reconnecting" about a connection given up on.
        const { client, lines, fatal, advance } = setup();

        client.emit(Events.ShardError, new Error('Used disallowed intents'), 0);
        client.emit(Events.ShardDisconnect, { code: GatewayCloseCodes.DisallowedIntents }, 0);
        advance(120_000);

        expect(lines).toHaveLength(1);
        expect(fatal).toHaveBeenCalledTimes(1);
    });
});

describe('a connection that drops and comes back', () => {
    test('is one line going and one line coming back, not one per attempt', () => {
        const { client, lines, fatal, advance } = setup();
        client.emit(Events.ClientReady);

        // As @discordjs/ws reports it: the socket error, then the reconnect, then another try.
        client.emit(Events.ShardError, new Error('read ECONNRESET'), 0);
        client.emit(Events.ShardReconnecting, 0);
        client.emit(Events.ShardError, new Error('connect ETIMEDOUT'), 0);
        client.emit(Events.ShardReconnecting, 0);
        advance(12_000);
        advance(3_000);
        client.emit(Events.ShardResume, 0, 12);

        expect(lines).toEqual([
            'warn [Discord] Gateway connection lost 12s ago (read ECONNRESET); still reconnecting',
            'info [Discord] Gateway back after 15s',
        ]);
        expect(fatal).not.toHaveBeenCalled();
    });

    test('a reconnect Discord asks for itself says nothing', () => {
        // Opcode 7, every few hours: discord.js reports it as reconnecting and then resumed,
        // a second later. Logging it would be a warning about nothing, several times a day.
        const { client, lines } = setup();
        client.emit(Events.ClientReady);

        client.emit(Events.ShardReconnecting, 0);
        client.emit(Events.ShardResume, 0, 3);

        expect(lines).toEqual([]);
    });

    test('and the next drop is logged again', () => {
        const { client, lines, advance } = setup();
        client.emit(Events.ClientReady);

        client.emit(Events.ShardReconnecting, 0);
        advance(11_000);
        client.emit(Events.ShardResume, 0, 0);
        client.emit(Events.ShardReconnecting, 0);
        advance(11_000);

        expect(lines.filter((l) => l.startsWith('warn'))).toHaveLength(2);
    });
});

describe('a connection that never comes back', () => {
    test('ends the process once it has been gone longer than the limit', () => {
        // @discordjs/ws retries for ever. A restart is the one thing that reliably gets a
        // stuck session out of that, and it takes the supervisor a second.
        const { client, fatal, advance } = setup();
        client.emit(Events.ClientReady);
        client.emit(Events.ShardReconnecting, 0);

        advance(59_000);
        expect(fatal).not.toHaveBeenCalled();

        advance(2_000);
        expect(fatal).toHaveBeenCalledTimes(1);
        expect(fatal.mock.calls[0][0]).toMatch(/61s/);
    });

    test('counts from startup when the first ready never arrives', () => {
        const { fatal, advance } = setup();

        advance(61_000);

        expect(fatal).toHaveBeenCalledTimes(1);
    });

    test('says so only once', () => {
        const { fatal, advance } = setup();

        advance(61_000);
        advance(61_000);

        expect(fatal).toHaveBeenCalledTimes(1);
    });

    test('an error on a connection that stays up is not a lost connection', () => {
        const { client, lines, fatal, advance } = setup();
        client.emit(Events.ClientReady);

        client.emit(Events.ShardError, new Error('something odd'), 0);
        advance(10 * 60_000);

        expect(lines).toEqual([]);
        expect(fatal).not.toHaveBeenCalled();
    });

    test('a connection that is up is never a reason', () => {
        const { client, fatal, advance } = setup();
        client.emit(Events.ClientReady);

        advance(10 * 60_000);

        expect(fatal).not.toHaveBeenCalled();
    });
});

test('stop() removes every listener and the timer', () => {
    const { client, watch } = setup({ checkEveryMs: 1000 });

    watch.stop();

    for (const event of [Events.ClientReady, Events.ShardDisconnect, Events.ShardReconnecting, Events.ShardResume, Events.ShardError, Events.ShardReady]) {
        expect(client.listenerCount(event)).toBe(0);
    }
});
