import redis from 'redis';
import logger from '../util/logger.js';

/**
 * FAIL FAST, NEVER HANG.
 *
 * node-redis queues commands issued while the connection is down in an unbounded offline
 * queue, and the promise it hands back does not settle until the connection comes back. The
 * update loop's first act on every status page is a lock read, so with Redis unreachable that
 * read never settled, `Promise.allSettled` never settled, the cycle never finished and the
 * `setTimeout` that schedules the next one never ran. The bot stayed logged in and kept
 * answering slash commands while every subscriber's status embed silently froze at whatever
 * it last showed — through a real incident, for the whole outage, with nothing in the log.
 *
 * `disableOfflineQueue` turns that into an immediate rejection, which callers can handle.
 */
const client = redis.createClient({
    url: `redis://${process.env.REDIS_PASSWORD}@${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`,
    disableOfflineQueue: true,
    socket: {
        connectTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 5000),
        // Keep trying, with a ceiling, so the bot rejoins on its own when Redis returns.
        reconnectStrategy: (retries) => Math.min(200 * (retries + 1), 5000),
    },
});

client.on('connect', () => { logger.info('[Redis] Connected'); });

// Reconnect noise is expected during an outage and must not be one line per attempt.
client.on('error', (error) => {
    logger.once('redis:error', 'error', `[Redis] ${error.message}`);
});
client.on('ready', () => { logger.resetOnce('redis:error'); });

// A Redis that is down at boot must not take the process with it as an unhandled rejection;
// the client keeps reconnecting on its own.
client.connect().catch((error) => {
    logger.error(`[Redis] Initial connection failed: ${error.message}`);
});

export default client;
