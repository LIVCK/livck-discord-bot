/**
 * Apply pending migrations before the bot does anything.
 *
 * The Docker entrypoint already runs `migrate.js` and refuses to start on failure, but a
 * direct `node server.js` did not — and the README's "run migrations, then start" is a step
 * someone has to remember. Forgetting it is not a loud failure: the update loop selects
 * columns that would not exist, every query fails, one error is logged per cycle and nothing
 * is ever delivered, while the process stays up so no supervisor notices.
 *
 * So the bot checks for itself. In the normal case there is nothing to do and it costs one
 * query. When there IS something to do it is applied and named in the log; when applying it
 * fails the process exits rather than running against a schema it cannot use.
 *
 * This shares Umzug's storage table with `migrate.js`, so running both is a no-op for the
 * second one — the Docker path stays exactly as it is.
 *
 * ONE INSTANCE ASSUMED. Two bots starting at the same moment against one database could both
 * try to apply the same migration; the loser fails and exits, and its supervisor restarts it
 * into a database that is by then already migrated. That is acceptable for a single-instance
 * deployment and worth knowing before it becomes a fleet.
 */

import { Umzug, SequelizeStorage } from 'umzug';
import { Sequelize } from 'sequelize';
import path from 'path';
import connection from '../database/index.js';

export const buildUmzug = (sequelize = connection) => new Umzug({
    migrations: {
        glob: path.resolve('./migrations/*.js'),
        resolve: ({ name, path: file, context }) => ({
            name,
            up: async () => (await import(file)).default.up(context, Sequelize),
            down: async () => (await import(file)).default.down(context, Sequelize),
        }),
    },
    context: sequelize.getQueryInterface(),
    storage: new SequelizeStorage({ sequelize }),
    // Quiet unless something actually happens — this runs on every boot.
    logger: undefined,
});

/**
 * @returns {Promise<string[]>} the names applied, empty when the schema was already current
 */
export const migrateOnStart = async (sequelize = connection) => {
    const umzug = buildUmzug(sequelize);

    const pending = await umzug.pending();
    if (pending.length === 0) return [];

    console.log(`[Migrate] Applying ${pending.length} pending migration(s)…`);
    const applied = await umzug.up();
    for (const migration of applied) console.log(`[Migrate]   ${migration.name}`);

    return applied.map((migration) => migration.name);
};

export default { migrateOnStart, buildUmzug };
