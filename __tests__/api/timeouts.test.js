/**
 * A status page that stops answering.
 *
 * Every request to a status page carries a deadline, and the tests that existed only checked
 * that a `signal` was passed — `new AbortController().signal`, which never fires, would have
 * satisfied them. These talk to a real socket that never answers, and to one that sends its
 * headers and then stalls in the middle of the body, which a deadline on the headers alone
 * would not catch.
 */

import http from 'http';

process.env.LIVCK_TIMEOUT_MS = '300';
process.env.LIVCK_DETECT_TIMEOUT_MS = '300';

const { default: LIVCKCloud } = await import('../../api/livckCloud.js');
const { default: LIVCK } = await import('../../api/livck.js');
const { detectSource } = await import('../../api/detect.js');

const servers = [];
const start = (handler) => new Promise((resolve) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
});

afterAll(async () => {
    for (const server of servers) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});

/** Never answers at all. */
const silent = () => start(() => {});

/** Answers at once with headers and half a JSON body, then nothing more. */
const stalling = () => start((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', server: 'LIVCK Cloud', 'lvk-version': '3' });
    res.write('{"page":{"id":"x"},"data":[');
});

/** Settles within `ms`, or fails the test with how long it actually took. */
const settlesWithin = async (promise, ms) => {
    const started = Date.now();
    let outcome;
    await Promise.race([
        promise.then(() => { outcome = 'resolved'; }, (error) => { outcome = error; }),
        new Promise((resolve) => setTimeout(resolve, ms)),
    ]);
    if (outcome === undefined) throw new Error(`still pending after ${ms}ms`);
    return { outcome, took: Date.now() - started };
};

/**
 * Gave up because of the deadline, not for any other reason. A DOMException from another realm
 * under Jest, hence the name rather than instanceof.
 */
const timedOut = (outcome) => expect(outcome?.name).toMatch(/TimeoutError|AbortError/);

describe.each([
    ['a page that never answers', silent],
    ['a page that stalls in the middle of its body', stalling],
])('%s', (_name, server) => {
    test('the Cloud client gives up at its deadline', async () => {
        const base = await server();
        const { outcome } = await settlesWithin(new LIVCKCloud(base, 'x').fetchFull(), 2000);
        timedOut(outcome);
    });

    test('the self-hosted client gives up at its deadline', async () => {
        const base = await server();
        const { outcome } = await settlesWithin(new LIVCK(base).get('monitors'), 2000);
        timedOut(outcome);
    });
});

test('detection gives up at its deadline on a page that never answers', async () => {
    // Detection reads headers only, so a stalled body cannot hold it; silence can.
    const base = await silent();
    const { outcome } = await settlesWithin(detectSource(base), 2000);
    timedOut(outcome);
});
