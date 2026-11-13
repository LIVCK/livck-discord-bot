/**
 * Noticing when the gateway is gone, and leaving when it is not coming back.
 *
 * The bot has two connections to Discord. The update loop uses REST, one request at a time,
 * and works with or without the other one. Slash commands, buttons and modals arrive over the
 * GATEWAY alone — so when that is lost, the bot keeps posting status updates, looks healthy in
 * every log line, and answers no /livck in any guild. Nothing used to say so.
 *
 * Two ways it does not come back by itself:
 *
 *   1. A close code discord.js treats as final — the token was reset (4004), an intent is not
 *      enabled for the application (4014), and a few more. It emits `shardDisconnect` and never
 *      tries again.
 *   2. A reconnect that does not get anywhere. @discordjs/ws retries for ever; a session that
 *      is stuck in it stays stuck.
 *
 * Both end the process with a failure code, through the normal shutdown, so the supervisor
 * restarts it — a fresh login gets out of the second, and a crash loop is a far louder way to
 * learn about the first than a bot that silently stopped answering.
 *
 * A drop that recovers within GRACE_MS says nothing. Discord asks every connection to
 * reconnect every few hours (opcode 7), which discord.js reports exactly like a lost one and
 * resumes a second later. A drop that lasts is one line going and one line coming back.
 */

import { Events, GatewayCloseCodes } from 'discord.js';
import logger from '../util/logger.js';

const STALL_MS = Number(process.env.GATEWAY_STALL_MINUTES || 10) * 60_000;
const GRACE_MS = 30_000;

/**
 * @param {import('events').EventEmitter} client
 * @param {object} options
 * @param {(reason: string) => void} options.onFatal - called once, when the gateway is not coming back
 * @param {(level: string, line: string) => void} [options.log]
 * @param {number} [options.stallMs] - how long it may be down before that counts as not coming back
 * @param {number} [options.graceMs] - how long it may be down before that is worth a line
 * @param {number} [options.checkEveryMs] - 0 disables the timer; tests call check()
 * @param {() => number} [options.now]
 */
export const watchGateway = (client, {
    onFatal,
    log = (level, line) => logger[level](line),
    stallMs = STALL_MS,
    graceMs = GRACE_MS,
    checkEveryMs = 10_000,
    now = Date.now,
} = {}) => {
    /** Not up until the first ready: a login that never gets there counts too. */
    let downSince = now();
    let lostLogged = false;
    let gaveUp = false;

    const giveUp = (reason) => {
        if (gaveUp) return;
        gaveUp = true;
        onFatal(reason);
    };

    const up = () => {
        if (downSince !== null && lostLogged) {
            log('info', `[Discord] Gateway back after ${Math.round((now() - downSince) / 1000)}s`);
        }
        downSince = null;
        lostLogged = false;
        reason = null;
    };

    // Why it went, for the line written once it has been gone long enough to matter.
    let reason = null;

    const lost = (why) => {
        if (downSince === null) downSince = now();
        if (why) reason = why;
    };

    const listeners = {
        [Events.ClientReady]: () => up(),
        [Events.ShardReady]: () => up(),
        [Events.ShardResume]: () => up(),
        // The socket error comes first and the reconnect after it; only the first is kept.
        // Only its message: an error is not a lost connection until discord.js says it is
        // reconnecting, and a restart over one that never was would be worse than the error.
        [Events.ShardError]: (error) => { if (reason === null) reason = error?.message ?? String(error); },
        [Events.ShardReconnecting]: () => lost(null),
        [Events.ShardDisconnect]: (event) => {
            const code = event?.code;
            const name = GatewayCloseCodes[code] ?? 'unknown';
            log('error', `[Discord] Gateway closed with ${code} (${name}); discord.js will not reconnect after that`);
            giveUp(`closed with ${code} (${name})`);
        },
    };

    for (const [event, fn] of Object.entries(listeners)) client.on(event, fn);

    const check = () => {
        if (downSince === null || gaveUp) return;
        const gone = now() - downSince;

        if (gone > graceMs && !lostLogged) {
            lostLogged = true;
            log('warn', `[Discord] Gateway connection lost ${Math.round(gone / 1000)}s ago${reason ? ` (${reason})` : ''}; still reconnecting`);
        }

        if (gone <= stallMs) return;
        const seconds = Math.round(gone / 1000);
        log('error', `[Discord] Gateway has not been ready for ${seconds}s; restarting to get a fresh session`);
        giveUp(`not ready for ${seconds}s`);
    };

    const timer = checkEveryMs > 0 ? setInterval(check, checkEveryMs) : null;
    timer?.unref?.();

    return {
        check,
        stop() {
            if (timer) clearInterval(timer);
            for (const [event, fn] of Object.entries(listeners)) client.off(event, fn);
        },
    };
};

export default watchGateway;
