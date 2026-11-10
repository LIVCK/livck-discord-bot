/**
 * The bot connects where migrate.js connects.
 *
 * `.env.example` documents DB_PORT and DB_DIALECT, and migrate.js has always honoured both.
 * The bot's own connection ignored them, so on a database outside port 3306 the migrations
 * succeeded and the bot then connected somewhere else: to nothing, or to whatever else was
 * listening on 3306.
 */

// Jest reuses a worker's process for later files, and process.env is not sandboxed like the
// module registry is. Put everything back afterwards.
const saved = { ...process.env };

process.env.DB_HOST = '127.0.0.1';
process.env.DB_PORT = '3999';
process.env.DB_DIALECT = 'mysql';
process.env.DB_DATABASE = 'none';
process.env.DB_USERNAME = 'none';
process.env.DB_PASSWORD = 'none';

const { default: connection } = await import('../../database/index.js');

afterAll(async () => {
    await connection.close().catch(() => {});
    for (const key of ['DB_HOST', 'DB_PORT', 'DB_DIALECT', 'DB_DATABASE', 'DB_USERNAME', 'DB_PASSWORD']) {
        if (key in saved) process.env[key] = saved[key];
        else delete process.env[key];
    }
});

test('uses DB_PORT', () => {
    expect(Number(connection.config.port)).toBe(3999);
});

test('uses DB_DIALECT', () => {
    expect(connection.getDialect()).toBe('mysql');
});
