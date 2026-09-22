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
 * @param {Array<() => Promise<unknown>>} options.close - connections to let go of
 * @param {number} [options.deadlineMs] - leave anyway after this
 * @param {(code: number) => void} [options.exit]
 * @param {(...args: unknown[]) => void} [options.log]
 * @returns {(signal: string) => Promise<void>} the handler to register on the signals
 */
export const createShutdown = ({
    stopLoop,
    close = [],
    deadlineMs = Number(process.env.SHUTDOWN_DEADLINE_MS || 5000),
    exit = (code) => process.exit(code),
    log = console.log,
} = {}) => {
    let started = false;

    return async (signal) => {
        // A second signal must not start a second teardown: closing a pool twice throws, and
        // the throw would land in a signal handler where nothing catches it.
        if (started) return;
        started = true;

        log(`[Shutdown] ${signal} received, stopping.`);

        // Unref'd, so waiting for the deadline does not itself keep the process alive.
        const deadline = setTimeout(() => {
            log('[Shutdown] Deadline reached, exiting anyway.');
            exit(0);
        }, deadlineMs);
        deadline.unref?.();

        stopLoop?.();

        // allSettled: one connection refusing to close must not strand the others.
        await Promise.allSettled(close.map((closer) => closer()));

        clearTimeout(deadline);
        log('[Shutdown] Done.');
        exit(0);
    };
};

export default { createShutdown };
