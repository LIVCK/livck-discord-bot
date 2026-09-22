/**
 * Say what is missing, before anything tries to use it.
 *
 * Without this the first symptom of a missing REDIS_HOST is a `TypeError: Invalid URL` thrown
 * from inside node-redis at IMPORT time — `redis://undefined@undefined:undefined` — before any
 * handler exists to catch it. A missing DB_HOST is a socket timeout somewhere in Sequelize.
 * Neither says which variable was forgotten, and both look like a broken build rather than a
 * missing line in `.env`.
 *
 * server.js already refused to start without a Discord token; this covers the rest of what the
 * bot genuinely cannot run without.
 */

/** Variables with no sensible default. An empty password is legitimate; an empty host is not. */
export const REQUIRED = [
    'DISCORD_BOT_TOKEN',
    'DISCORD_CLIENT_ID',
    'DB_HOST',
    'DB_DATABASE',
    'DB_USERNAME',
    'REDIS_HOST',
    'REDIS_PORT',
];

/**
 * @returns {string[]} the names that are missing or blank
 */
export const missingEnv = (env = process.env) =>
    REQUIRED.filter((name) => env[name] === undefined || String(env[name]).trim() === '');

/** Report and exit when the process cannot possibly work. Returns the list otherwise. */
export const requireEnv = (env = process.env) => {
    const missing = missingEnv(env);

    if (missing.length > 0) {
        console.error(
            `Missing required environment variables: ${missing.join(', ')}\n` +
            'See .env.example. The bot cannot start without them.'
        );
        process.exit(1);
    }

    return missing;
};

export default { missingEnv, requireEnv, REQUIRED };
