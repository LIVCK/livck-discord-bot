import { Sequelize } from 'sequelize';
import { Umzug, SequelizeStorage } from 'umzug';
import dotenv from 'dotenv';

dotenv.config();

const sequelize = new Sequelize(
    process.env.DB_DATABASE,
    process.env.DB_USERNAME,
    process.env.DB_PASSWORD,
    {
        host: process.env.DB_HOST,
        dialect: process.env.DB_DIALECT || 'mariadb',
        port: process.env.DB_PORT || 3306,
    }
);

const umzug = new Umzug({
    migrations: {
        glob: 'migrations/*.js',
        resolve: ({ name, path, context }) => ({
            name,
            up: async () => (await import(path)).default.up(context, Sequelize),
            down: async () => (await import(path)).default.down(context, Sequelize),
        }),
    },
    context: sequelize.getQueryInterface(),
    storage: new SequelizeStorage({ sequelize }),
    logger: console,
});

// Migrationen ausführen
(async () => {
    try {
        await umzug.up();
        console.log('Migrated successfully.');
    } catch (error) {
        console.error('Error migrating:', error);

        // The README tells operators to run `node migrate.js` and then start the bot. Exiting
        // 0 on failure makes a failed or half-applied migration indistinguishable from success
        // in any `migrate && start` chain, entrypoint or CI step — on precisely the deploy that
        // adds the columns the update loop now selects unconditionally.
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
})();
