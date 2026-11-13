/**
 * The real bot, as a process: `node server.js`, its own database, its own Redis keys, talking to
 * the simulated Discord and the simulated status pages. Nothing in it is mocked — what runs is
 * what production runs, migrations and shutdown included.
 *
 * Every variable the bot reads is set here, explicitly. server.js loads `.env` from its working
 * directory, and dotenv fills in whatever is missing; leaving one out would let a developer's
 * real credentials into a simulation.
 */

import fs from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { createClient } from 'redis';
import { APP_ID } from './discord.js';

const run = promisify(execFile);
const PRELOAD = path.resolve('__tests__/sim/harness/preload.cjs');

export const dbConfig = () => ({
    host: process.env.SIM_DB_HOST || '127.0.0.1',
    port: Number(process.env.SIM_DB_PORT || 3306),
    user: process.env.SIM_DB_USER || 'root',
    password: process.env.SIM_DB_PASSWORD || '',
});

export const redisConfig = () => ({
    host: process.env.SIM_REDIS_HOST || '127.0.0.1',
    port: Number(process.env.SIM_REDIS_PORT || 6379),
    password: process.env.SIM_REDIS_PASSWORD || '',
});

/** A database of its own for one scenario, dropped again at the end. */
export const createDatabase = async () => {
    const name = `livck_sim_${crypto.randomBytes(4).toString('hex')}`;
    const admin = await mysql.createConnection(dbConfig());
    await admin.query(`CREATE DATABASE \`${name}\``);
    await admin.end();
    // UTC, as Sequelize in the bot reads and writes it. mysql2's default is local time, which
    // moved every date the harness wrote by the machine's UTC offset as far as the bot could tell.
    const db = await mysql.createConnection({ ...dbConfig(), database: name, timezone: 'Z' });
    return {
        name,
        db,
        query: async (sql, params) => (await db.query(sql, params))[0],
        async drop() {
            await db.end().catch(() => {});
            const again = await mysql.createConnection(dbConfig());
            await again.query(`DROP DATABASE IF EXISTS \`${name}\``);
            await again.end();
        },
    };
};

/**
 * A Redis database per Jest worker (1–15), with the bot's keys from an earlier run cleared —
 * only `dc-bot:*`, in case it is shared. Scenarios running in parallel then never see each
 * other's page claims, which would otherwise make one bot skip the other's pages. `SIM_REDIS_DB`
 * overrides it, for two separate runs on one machine.
 */
export const claimRedisDb = async () => {
    const db = Number(process.env.SIM_REDIS_DB || ((Number(process.env.JEST_WORKER_ID || 1) - 1) % 15) + 1);
    const { host, port, password } = redisConfig();
    const client = createClient({ url: `redis://${password ? `:${password}@` : ''}${host}:${port}/${db}` });
    await client.connect();
    for await (const keys of client.scanIterator({ MATCH: 'dc-bot:*', COUNT: 500 })) {
        const list = Array.isArray(keys) ? keys : [keys];
        if (list.length > 0) await client.del(list);
    }
    await client.quit();
    return db;
};

/** The settings every simulated bot runs with. Short cycles, everything else as shipped. */
export const simEnv = ({ discord, database, redisDb = 0, overrides = {} }) => {
    const { host, port, user, password } = dbConfig();
    const redis = redisConfig();
    return {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: 'production',
        SIM_DISCORD_API: discord.api,
        DISCORD_BOT_TOKEN: 'sim.token.not-a-secret',
        DISCORD_CLIENT_ID: APP_ID,
        DISCORD_CLIENT_SECRET: 'sim',
        DB_HOST: host,
        DB_PORT: String(port),
        DB_DIALECT: 'mariadb',
        DB_DATABASE: database.name,
        DB_USERNAME: user,
        DB_PASSWORD: password,
        REDIS_HOST: redis.host,
        REDIS_PORT: String(redis.port),
        REDIS_PASSWORD: redis.password,
        REDIS_DB: String(redisDb),
        LOG_LEVEL: 'info',
        UPDATE_INTERVAL_MS: '1000',
        REDIS_LOCK_TTL_SECONDS: '1',
        SNAPSHOT_TTL_MS: '300',
        // No heartbeat edits inside a scenario: every edit the referee sees must be a change.
        STATUS_REFRESH_MINUTES: '600',
        ALERT_CLOSEOUT_RECHECK_MS: '1500',
        DISCORD_DELIVERY_TIMEOUT_MS: '3000',
        DELIVERY_BACKOFF_BASE_MS: '500',
        UPDATE_PAGE_DEADLINE_MS: '8000',
        LIVCK_TIMEOUT_MS: '3000',
        LIVCK_DETECT_TIMEOUT_MS: '3000',
        SHUTDOWN_DEADLINE_MS: '8000',
        GATEWAY_STALL_MINUTES: '5',
        ...overrides,
    };
};

/** Run migrate.js of a given checkout against the scenario's database. */
export const migrate = async ({ cwd = process.cwd(), env }) => {
    await run(process.execPath, ['migrate.js'], { cwd, env, timeout: 60_000 });
};

/**
 * Start the bot. `cwd` may be another checkout — an older release, for a rollout.
 * @returns the process, with its log and ways to wait on it
 */
/**
 * The command that runs the bot: `node server.js` in a checkout, or — with `image` — the Docker
 * image itself, through its own entrypoint (migrations first, then the bot), exactly as it is
 * deployed. The preload goes in through NODE_OPTIONS, so the image needs no change for it.
 */
const command = ({ cwd, env, image, name }) => {
    if (!image) return [process.execPath, ['--require', PRELOAD, 'server.js'], { cwd, env }];
    const pass = Object.entries({ ...env, NODE_OPTIONS: '--require /sim/preload.cjs' })
        .filter(([key]) => !['PATH', 'HOME'].includes(key))
        .flatMap(([key, value]) => ['-e', `${key}=${value}`]);
    return ['docker', ['run', '--rm', '--name', name, '--network', 'host', '-v', `${PRELOAD}:/sim/preload.cjs:ro`, ...pass, image], { env: process.env }];
};

export const startBot = ({ cwd = process.cwd(), env, label = 'bot', image = null }) => {
    const name = `livck-sim-${env.DB_DATABASE}-${label}`;
    const [file, args, options] = command({ cwd, env, image, name });
    const child = spawn(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = [];
    // SIM_LOG_DIR keeps every bot's whole log, one file per database and process — what CI
    // uploads when a scenario fails.
    const logFile = process.env.SIM_LOG_DIR
        ? path.join(process.env.SIM_LOG_DIR, `${env.DB_DATABASE}-${label}.log`) : null;
    if (logFile) fs.mkdirSync(process.env.SIM_LOG_DIR, { recursive: true });
    const waiters = new Set();
    let exit = null;

    const onLine = (line) => {
        const entry = { at: Date.now(), line };
        lines.push(entry);
        if (logFile) fs.appendFileSync(logFile, `${new Date(entry.at).toISOString()} ${line}\n`);
        if (process.env.SIM_VERBOSE) process.stdout.write(`[${label}] ${line}\n`);
        for (const waiter of waiters) waiter(entry);
    };
    for (const stream of [child.stdout, child.stderr]) {
        let buffer = '';
        stream.on('data', (chunk) => {
            buffer += chunk;
            const parts = buffer.split('\n');
            buffer = parts.pop();
            parts.forEach(onLine);
        });
    }
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => { exit = { code, signal }; resolve(exit); }));

    const bot = {
        child,
        lines,
        label,
        exited,
        get exit() { return exit; },
        log: () => lines.map((l) => l.line).join('\n'),

        /** Resolves with the first line after now that matches. */
        waitFor(pattern, { timeout = 30_000 } = {}) {
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    waiters.delete(check);
                    reject(new Error(`${label}: no line matching ${pattern} within ${timeout}ms\n--- last lines ---\n${lines.slice(-25).map((l) => l.line).join('\n')}`));
                }, timeout);
                const check = (entry) => {
                    if (pattern.test(entry.line)) {
                        clearTimeout(timer);
                        waiters.delete(check);
                        resolve(entry);
                    }
                };
                waiters.add(check);
                exited.then(() => {
                    if (!waiters.has(check)) return;
                    clearTimeout(timer);
                    waiters.delete(check);
                    reject(new Error(`${label} exited (${JSON.stringify(exit)}) while waiting for ${pattern}\n${lines.slice(-25).map((l) => l.line).join('\n')}`));
                });
            });
        },

        /** Wait for `n` more update cycles to complete. */
        async cycles(n = 1, { timeout = 30_000 } = {}) {
            for (let i = 0; i < n; i += 1) await bot.waitFor(/^\[UpdateLoop\] \d+ due/, { timeout });
        },

        /** SIGTERM and wait — a deploy. */
        async stop({ timeout = 20_000 } = {}) {
            if (exit) return exit;
            if (image) spawn('docker', ['stop', '-t', String(Math.round(timeout / 1000)), name], { stdio: 'ignore' });
            else child.kill('SIGTERM');
            const timer = setTimeout(() => (image ? spawn('docker', ['kill', name], { stdio: 'ignore' }) : child.kill('SIGKILL')), timeout + 5000);
            await exited;
            clearTimeout(timer);
            return exit;
        },

        /** SIGKILL — the host died. */
        async kill() {
            if (exit) return exit;
            if (image) spawn('docker', ['kill', name], { stdio: 'ignore' });
            else child.kill('SIGKILL');
            return exited;
        },

        /** Lines that look like something went wrong, for the report. */
        errors: () => lines.filter((l) => /error|unhandled|uncaught|TypeError|ReferenceError/i.test(l.line)).map((l) => l.line),
    };
    return bot;
};

export default { createDatabase, claimRedisDb, simEnv, migrate, startBot, dbConfig, redisConfig };
