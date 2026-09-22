/**
 * Refusing an oversized body from a URL the bot does not control.
 *
 * Every status page is a URL some guild admin typed into `/livck subscribe`. `response.json()`
 * buffers the whole body first, and Node's fetch transparently decompresses, so a 199 kB gzip
 * response becomes 200 MB in memory — measured: RSS 254 MB -> 895 MB in 206 ms. The loop
 * processes 100 pages concurrently, so a few such pages are an OOM kill of a bot that serves
 * every guild. `content-length` is no defence: it reports the COMPRESSED size.
 */

import zlib from 'zlib';
import http from 'http';
import { readJsonCapped, MAX_BODY_BYTES, BodyTooLargeError } from '../../util/readJson.js';

/** A real Response over a real socket, because the streaming path is the point. */
const serve = async (handler) => {
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        url: `http://127.0.0.1:${server.address().port}/`,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
};

describe('readJsonCapped', () => {
    test('reads an ordinary payload unchanged', async () => {
        const server = await serve((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ hello: 'world', list: [1, 2, 3] }));
        });

        try {
            const response = await fetch(server.url);
            await expect(readJsonCapped(response, server.url)).resolves.toEqual({
                hello: 'world', list: [1, 2, 3],
            });
        } finally {
            await server.close();
        }
    });

    test('refuses a body past the cap instead of buffering it', async () => {
        const server = await serve((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(Buffer.alloc(2048, 0x20));
        });

        try {
            const response = await fetch(server.url);
            await expect(readJsonCapped(response, server.url, 512)).rejects.toBeInstanceOf(BodyTooLargeError);
        } finally {
            await server.close();
        }
    });

    test('a gzip bomb is stopped at the DECOMPRESSED size', async () => {
        // The whole point: 200 kB on the wire, 32 MB once Node has decompressed it. Anything
        // that trusted content-length would have waved this straight through.
        const payload = Buffer.alloc(32 * 1024 * 1024, 0x20);
        const gz = zlib.gzipSync(payload);
        expect(gz.length).toBeLessThan(512 * 1024);

        const server = await serve((_req, res) => {
            res.writeHead(200, {
                'content-type': 'application/json',
                'content-encoding': 'gzip',
                'content-length': gz.length,
            });
            res.end(gz);
        });

        try {
            const response = await fetch(server.url);
            expect(Number(response.headers.get('content-length'))).toBeLessThan(512 * 1024);

            await expect(readJsonCapped(response, server.url, 1024 * 1024))
                .rejects.toBeInstanceOf(BodyTooLargeError);
        } finally {
            await server.close();
        }
    }, 30000);

    test('the refusal is classified as a plain bad response', async () => {
        // So the backoff and the pause notice treat it like any other HTTP failure rather
        // than as an unknown crash.
        const { classifyError, FAILURE_KINDS } = await import('../../util/errors.js');
        const error = new BodyTooLargeError('https://status.example.com', 100);

        expect(classifyError(error).kind).toBe(FAILURE_KINDS.HTTP_4XX);
        expect(error.status).toBe(413);
    });

    test('a mocked response without a stream still works', async () => {
        // Test doubles hand back a plain object with .json(); they are not hostile servers.
        const response = { json: async () => ({ ok: true }) };

        await expect(readJsonCapped(response, 'https://status.example.com')).resolves.toEqual({ ok: true });
    });

    test('the default cap is far above a real status page and far below harm', () => {
        expect(MAX_BODY_BYTES).toBeGreaterThan(1024 * 1024);
        expect(MAX_BODY_BYTES).toBeLessThan(64 * 1024 * 1024);
    });
});
