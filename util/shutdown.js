/**
 * Leaving on request, instead of being killed.
 *
 * The cycle timer keeps Node's event loop alive, so a SIGTERM used to do nothing at all:
 * `docker stop` waited its ten seconds and then SIGKILLed the process — exit 137, on every
 * deploy, with a cycle cut in half somewhere between sending a Discord message and writing the
 * row that remembers having sent it. Measured before and after: 10s/137 against 183ms/0.
 *
 * Its own module because a shutdown that goes wrong is worse than one that never runs — a
 * second signal that starts a second teardown, a close that hangs and never lets go — and none
 * of that is testable while it lives at the bottom of an entry point that opens a database
 * connection on import.
 */

/**
 * @param {object} options
 * @param {() => void} options.stopLoop - stop scheduling further cycles
 * @param {Array<() => Promise<unknown>>} [options.drain] - work to let finish first: the cycle
 *   in flight, and deliveries that outlived it
 * @param {Array<() => Promise<unknown>>} options.close - connections to let go of
 * @param {number} [options.deadlineMs] - leave anyway after this
 * @param {(code: number) => void} [options.exit]
 * @param {(...args: unknown[]) => void} [options.log]
 * @returns {(signal: string) => Promise<void>} the handler to register on the signals
 */
export const createShutdown = ({
    stopLoop,
    drain = [],
    close = [],
    deadlineMs = Number(process.env.SHUTDOWN_DEADLINE_MS || 5000),
    exit = (code) => process.exit(code),
    log = console.log,
} = {}) => {
    let started = false;

    return async (signal, code = 0) => {
        // A second signal must not start a second teardown: closing a pool twice throws, and
        // the throw would land in a signal handler where nothing catches it.
        if (started) return;
        started = true;

        log(`[Shutdown] ${signal}${code === 0 ? ' received' : ''}, stopping.`);

        // Unref'd, so waiting for the deadline does not itself keep the process alive.
        const deadline = setTimeout(() => {
            log('[Shutdown] Deadline reached, exiting anyway.');
            exit(code);
        }, deadlineMs);
        deadline.unref?.();

        stopLoop?.();

        // Let what is in flight finish BEFORE the connections go. A delivery that reaches
        // Discord after the database has closed is posted without the row that remembers it,
        // and the next process, finding no row, posts it a second time. Bounded to part of the
        // deadline, so the connections are still closed properly when something never ends.
        if (drain.length > 0) {
            let timer;
            await Promise.race([
                Promise.allSettled(drain.map((wait) => wait())),
                new Promise((resolve) => {
                    timer = setTimeout(resolve, Math.floor(deadlineMs * 0.6));
                    timer.unref?.();
                }),
            ]);
            clearTimeout(timer);
        }

        // allSettled: one connection refusing to close must not strand the others.
        await Promise.allSettled(close.map((closer) => closer()));

        clearTimeout(deadline);
        log('[Shutdown] Done.');
        exit(code);
    };
};

/**
 * The bot's own shutdown: what server.js registers on SIGTERM.
 *
 * Assembled here rather than in server.js so the ORDER can be tested — server.js opens a
 * database connection on import, and nothing there was covered. An empty `drain` would close the
 * database under deliveries still out, and every suite stayed green with it.
 *
 * @param {object} parts
 * @param {{destroy: () => Promise<void>, gatewayWatch?: {stop: () => void}}} parts.client
 * @param {() => void} parts.stopUpdateLoop
 * @param {() => Promise<void>} parts.whenCycleDone
 * @param {() => Promise<unknown>} parts.drainDeliveries
 * @param {() => Promise<unknown>} parts.closeDatabase
 * @param {{isOpen: boolean, quit: () => Promise<unknown>}} parts.cache
 */
export const createBotShutdown = ({ client, stopUpdateLoop, whenCycleDone, drainDeliveries, closeDatabase, cache, ...rest }) =>
    createShutdown({
        stopLoop: () => {
            stopUpdateLoop();
            // Before client.destroy(), which closes the gateway and would read as a lost connection.
            client.gatewayWatch?.stop();
        },
        // The cycle first, then whatever it left running: a page that overran its deadline is
        // still delivering, and the database has to outlive it.
        drain: [async () => { await whenCycleDone(); await drainDeliveries(); }],
        close: [
            () => client.destroy(),
            () => closeDatabase(),
            () => (cache.isOpen ? cache.quit() : Promise.resolve()),
        ],
        ...rest,
    });

export default { createShutdown, createBotShutdown };
