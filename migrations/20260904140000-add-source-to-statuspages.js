/**
 * Which product a status page runs, and its Cloud page id.
 *
 * Both nullable with no default: an existing row means "not probed yet", and the first cycle
 * after deploy detects and stores it. That is why there is no backfill here — a backfill would
 * mean one request per status page at migration time, and the update loop does it anyway.
 */
/**
 * Drop a column with raw SQL.
 *
 * `queryInterface.removeColumn` cannot run on this stack at all: Sequelize 6.37 issues a
 * foreign-key lookup as a raw query and then does `delete data.meta` on the result, while the
 * mariadb 3.4 driver returns a rows array whose `meta` is non-configurable — so every call
 * throws `Cannot delete property 'meta' of [object Array]` before touching the schema. That
 * left these migrations with no rollback path at all, which is not a state to discover while
 * reverting a release on a live database. `addColumn`, `changeColumn` and `describeTable` are
 * unaffected; only removal is.
 */
const dropColumn = async (queryInterface, table, column) => {
    const columns = await queryInterface.describeTable(table);
    if (!columns[column]) return;
    await queryInterface.sequelize.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
};

/** Add a column only when it is not already there, so a half-applied migration can be re-run. */
const addColumnIfMissing = async (queryInterface, table, column, definition) => {
    const columns = await queryInterface.describeTable(table);
    if (columns[column]) return;
    await queryInterface.addColumn(table, column, definition);
};

export default {
    async up(queryInterface, Sequelize) {
        // 'CLOUD' | 'SELF_HOSTED' | null. A STRING and not an ENUM for the same reason
        // pauseReason is one: widening an ENUM is a table alter every time.
        await addColumnIfMissing(queryInterface, 'Statuspages', 'kind', {
            type: Sequelize.STRING(16),
            allowNull: true,
            defaultValue: null,
        });

        // The Cloud's public page id (a 21-character nanoid). Caching it skips one
        // /status.json request per cycle.
        await addColumnIfMissing(queryInterface, 'Statuspages', 'externalId', {
            type: Sequelize.STRING(64),
            allowNull: true,
            defaultValue: null,
        });

        await addColumnIfMissing(queryInterface, 'Statuspages', 'detectedAt', {
            type: Sequelize.DATE,
            allowNull: true,
            defaultValue: null,
        });
    },

    async down(queryInterface) {
        await dropColumn(queryInterface, 'Statuspages', 'kind');
        await dropColumn(queryInterface, 'Statuspages', 'externalId');
        await dropColumn(queryInterface, 'Statuspages', 'detectedAt');
    },
};
