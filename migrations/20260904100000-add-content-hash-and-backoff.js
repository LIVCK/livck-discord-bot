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
export default {
    async up(queryInterface, Sequelize) {
        // Lets the update loop skip an edit when the rendered message is identical.
        await queryInterface.addColumn('Messages', 'contentHash', {
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
        await queryInterface.addColumn('Statuspages', 'backoffLevel', {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 0,
        });

        // Earliest time the loop may try this page again. NULL = try now.
        await queryInterface.addColumn('Statuspages', 'nextAttemptAt', {
            type: Sequelize.DATE,
            allowNull: true,
            defaultValue: null,
        });
    },

    async down(queryInterface, Sequelize) {
        await queryInterface.removeColumn('Messages', 'contentHash');
        await queryInterface.removeColumn('Statuspages', 'backoffLevel');
        await queryInterface.removeColumn('Statuspages', 'nextAttemptAt');

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
