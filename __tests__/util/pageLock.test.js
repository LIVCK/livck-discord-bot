/**
 * One render at a time, per page.
 *
 * `/livck` triggers an immediate refresh from seven places without taking the update loop's
 * Redis claim, so two renders of the same page can overlap — and each then finds no Message
 * row and posts one. This is what stops that.
 *
 * The map also has to empty itself: a bot watching a few hundred pages would otherwise grow
 * one entry per page and never give any of them back.
 */

import { withPageLock, pendingPages } from '../../util/pageLock.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('two calls for the same page', () => {
    test('do not overlap', async () => {
        const events = [];
        const slow = (label) => async () => {
            events.push(`${label}:start`);
            await new Promise((resolve) => setTimeout(resolve, 20));
            events.push(`${label}:end`);
        };

        await Promise.all([withPageLock(1, slow('a')), withPageLock(1, slow('b'))]);

        // Interleaved would read a:start, b:start, …
        expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
    });

    test('run in the order they were asked for', async () => {
        const order = [];
        await Promise.all([1, 2, 3, 4].map((n) => withPageLock('p', async () => { order.push(n); })));

        expect(order).toEqual([1, 2, 3, 4]);
    });

    test('the second still runs when the first throws', async () => {
        // A page that failed to render must not wedge every later render of that page.
        const order = [];
        const failing = withPageLock('p', async () => { order.push('first'); throw new Error('boom'); });

        await expect(failing).rejects.toThrow('boom');
        await withPageLock('p', async () => { order.push('second'); });

        expect(order).toEqual(['first', 'second']);
    });

    test('each caller gets its own result back', async () => {
        const [a, b] = await Promise.all([
            withPageLock('p', async () => 'A'),
            withPageLock('p', async () => 'B'),
        ]);

        expect([a, b]).toEqual(['A', 'B']);
    });
});

describe('different pages', () => {
    test('do not wait for each other', async () => {
        const events = [];
        const slow = (label) => async () => {
            events.push(`${label}:start`);
            await new Promise((resolve) => setTimeout(resolve, 20));
            events.push(`${label}:end`);
        };

        await Promise.all([withPageLock('one', slow('a')), withPageLock('two', slow('b'))]);

        // Both started before either finished.
        expect(events.slice(0, 2).sort()).toEqual(['a:start', 'b:start']);
    });

    test('a numeric id and its string form are the same page', async () => {
        const events = [];
        await Promise.all([
            withPageLock(7, async () => { events.push('number'); await settle(); }),
            withPageLock('7', async () => { events.push('string'); }),
        ]);

        expect(events).toEqual(['number', 'string']);
    });
});

describe('the queue', () => {
    test('empties itself, so a fleet cannot grow it without bound', async () => {
        await Promise.all([1, 2, 3, 4, 5].map((id) => withPageLock(id, async () => {})));
        await settle();
        await settle();

        expect(pendingPages()).toBe(0);
    });

    test('empties itself after a failure too', async () => {
        await withPageLock('p', async () => { throw new Error('boom'); }).catch(() => {});
        await settle();
        await settle();

        expect(pendingPages()).toBe(0);
    });
});
