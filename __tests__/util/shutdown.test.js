/**
 * Leaving on request.
 *
 * Verified once by hand — `docker stop` went from 10 seconds and exit 137 to 183ms and exit 0
 * — and by nothing since. These are the parts of it that can go wrong quietly: a second signal
 * tearing down a second time, a connection that hangs, a close that throws.
 */

import { jest } from '@jest/globals';
import { createShutdown } from '../../util/shutdown.js';

const harness = (overrides = {}) => {
    const events = [];
    const exit = jest.fn();

    const shutdown = createShutdown({
        stopLoop: () => events.push('stopLoop'),
        close: [
            async () => { events.push('discord'); },
            async () => { events.push('database'); },
            async () => { events.push('redis'); },
        ],
        exit,
        log: () => {},
        ...overrides,
    });

    return { shutdown, events, exit };
};

describe('on a signal', () => {
    test('scheduling stops before anything is closed', async () => {
        // The other order would let a cycle start against a pool that is going away.
        const { shutdown, events } = harness();

        await shutdown('SIGTERM');

        expect(events[0]).toBe('stopLoop');
        expect(events).toHaveLength(4);
    });

    test('everything is closed, and the process leaves with 0', async () => {
        const { shutdown, events, exit } = harness();

        await shutdown('SIGTERM');

        expect(new Set(events)).toEqual(new Set(['stopLoop', 'discord', 'database', 'redis']));
        expect(exit).toHaveBeenCalledWith(0);
    });
});

describe('leaving because something is broken', () => {
    test('tears down the same way, and exits non-zero so the supervisor sees a failure', async () => {
        // A gateway Discord will not let back in (util/gatewayWatch.js). Leaving with 0 would
        // read as a requested stop, and a restart policy of on-failure would leave it stopped.
        const { shutdown, events, exit } = harness();

        await shutdown('gateway', 1);

        expect(new Set(events)).toEqual(new Set(['stopLoop', 'discord', 'database', 'redis']));
        expect(exit).toHaveBeenCalledWith(1);
    });

    test('keeps the code when the deadline cuts it short', async () => {
        jest.useFakeTimers();
        try {
            const { shutdown, exit } = harness({ close: [() => new Promise(() => {})], deadlineMs: 100 });

            shutdown('gateway', 1);
            await jest.advanceTimersByTimeAsync(150);

            expect(exit).toHaveBeenCalledWith(1);
        } finally {
            jest.useRealTimers();
        }
    });
});

describe('a second signal', () => {
    test('does not start a second teardown', async () => {
        // Closing a pool twice throws, and the throw would land in a signal handler where
        // nothing catches it. Impatient operators press Ctrl-C twice.
        const { shutdown, events, exit } = harness();

        await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT'), shutdown('SIGTERM')]);

        expect(events.filter((e) => e === 'database')).toHaveLength(1);
        expect(exit).toHaveBeenCalledTimes(1);
    });
});

describe('when a connection misbehaves', () => {
    test('one that throws does not strand the others', async () => {
        const events = [];
        const exit = jest.fn();
        const shutdown = createShutdown({
            stopLoop: () => {},
            close: [
                async () => { throw new Error('discord refused'); },
                async () => { events.push('database'); },
                async () => { events.push('redis'); },
            ],
            exit,
            log: () => {},
        });

        await shutdown('SIGTERM');

        expect(events).toEqual(['database', 'redis']);
        expect(exit).toHaveBeenCalledWith(0);
    });

    test('one that hangs is given up on at the deadline', async () => {
        // A shutdown that never finishes is no better than one that never starts: Docker would
        // wait its ten seconds and SIGKILL, which is the behaviour this replaced.
        jest.useFakeTimers();
        const exit = jest.fn();

        const shutdown = createShutdown({
            stopLoop: () => {},
            close: [() => new Promise(() => {})],
            deadlineMs: 5000,
            exit,
            log: () => {},
        });

        shutdown('SIGTERM');
        await Promise.resolve();
        expect(exit).not.toHaveBeenCalled();

        jest.advanceTimersByTime(5000);
        expect(exit).toHaveBeenCalledWith(0);

        jest.useRealTimers();
    });

    test('the deadline timer does not itself keep the process alive', () => {
        // An un-unref'd timer would hold the event loop open for the whole deadline, which is
        // the exact class of bug being fixed here.
        jest.useFakeTimers();
        const unref = jest.fn();
        jest.spyOn(global, 'setTimeout').mockImplementation(() => ({ unref }));

        const shutdown = createShutdown({ stopLoop: () => {}, close: [], exit: () => {}, log: () => {} });
        shutdown('SIGTERM');

        expect(unref).toHaveBeenCalled();

        global.setTimeout.mockRestore();
        jest.useRealTimers();
    });
});

describe('with nothing to close', () => {
    test('it still stops the loop and leaves', async () => {
        const stopLoop = jest.fn();
        const exit = jest.fn();

        await createShutdown({ stopLoop, close: [], exit, log: () => {} })('SIGINT');

        expect(stopLoop).toHaveBeenCalled();
        expect(exit).toHaveBeenCalledWith(0);
    });
});

describe('work still in flight', () => {
    test('is waited for before anything is closed', async () => {
        // A delivery can outlive its cycle now (util/delivery.js), and a message that reaches
        // Discord after the database closed is posted without the row that remembers it — so
        // the next process posts it a second time.
        const events = [];
        let finish;
        const pending = new Promise((resolve) => { finish = resolve; });

        const shutdown = createShutdown({
            stopLoop: () => events.push('stopLoop'),
            drain: [async () => { await pending; events.push('drained'); }],
            close: [async () => { events.push('database'); }],
            exit: () => {},
            log: () => {},
        });

        const done = shutdown('SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(events).toEqual(['stopLoop']);

        finish();
        await done;
        expect(events).toEqual(['stopLoop', 'drained', 'database']);
    });

    test('is not waited for past the point where the connections could still be closed', async () => {
        const events = [];
        const exit = jest.fn();

        const shutdown = createShutdown({
            stopLoop: () => {},
            drain: [() => new Promise(() => {})],
            close: [async () => { events.push('database'); }],
            deadlineMs: 400,
            exit,
            log: () => {},
        });

        await shutdown('SIGTERM');

        expect(events).toEqual(['database']);
        expect(exit).toHaveBeenCalledWith(0);
    });
});
