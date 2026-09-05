/**
 * Phase 0 schema: message change detection + exponential backoff.
 *
 * Additive only. Existing rows get `contentHash = NULL`, which reads as "unknown" and makes
 * the first cycle after deploy edit once and store the hash — no backfill needed.
 *
 * `pauseReason` moves from ENUM to VARCHAR because the set of failure kinds grew (DNS, TLS,
 * HTTP_4XX, HTTP_5XX, RATE_LIMITED, …) and will grow again for the Cloud. Widening an ENUM
 * is a table alter every single time; a VARCHAR is not. Existing values survive the
 * conversion unchanged.
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
        // Lets the update loop skip an edit when the rendered message is identical.
        await addColumnIfMissing(queryInterface, 'Messages', 'contentHash', {
            type: Sequelize.STRING(64),
            allowNull: true,
            defaultValue: null,
        });

        await queryInterface.changeColumn('Statuspages', 'pauseReason', {
            type: Sequelize.STRING(32),
            allowNull: true,
            defaultValue: null,
        });

        // Current rung of the backoff ladder; 0 = healthy.
        await addColumnIfMissing(queryInterface, 'Statuspages', 'backoffLevel', {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 0,
        });

        // Earliest time the loop may try this page again. NULL = try now.
        await addColumnIfMissing(queryInterface, 'Statuspages', 'nextAttemptAt', {
            type: Sequelize.DATE,
            allowNull: true,
            defaultValue: null,
        });
    },

    async down(queryInterface, Sequelize) {
        await dropColumn(queryInterface, 'Messages', 'contentHash');
        await dropColumn(queryInterface, 'Statuspages', 'backoffLevel');
        await dropColumn(queryInterface, 'Statuspages', 'nextAttemptAt');

        // Values outside the original ENUM cannot be represented; clear them so the
        // narrowing cannot fail on live data.
        await queryInterface.sequelize.query(
            "UPDATE Statuspages SET pauseReason = NULL WHERE pauseReason NOT IN ('TIMEOUT', 'NOT_LIVCK', 'MANUAL')"
        );
        await queryInterface.changeColumn('Statuspages', 'pauseReason', {
            type: Sequelize.ENUM('TIMEOUT', 'NOT_LIVCK', 'MANUAL'),
            allowNull: true,
            defaultValue: null,
        });
    },
};
