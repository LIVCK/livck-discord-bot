/**
 * Which product a status page runs, and its Cloud page id.
 *
 * Both nullable with no default: an existing row means "not probed yet", and the first cycle
 * after deploy detects and stores it. That is why there is no backfill here — a backfill would
 * mean one request per status page at migration time, and the update loop does it anyway.
 */
export default {
    async up(queryInterface, Sequelize) {
        // 'CLOUD' | 'SELF_HOSTED' | null. A STRING and not an ENUM for the same reason
        // pauseReason is one: widening an ENUM is a table alter every time.
        await queryInterface.addColumn('Statuspages', 'kind', {
            type: Sequelize.STRING(16),
            allowNull: true,
            defaultValue: null,
        });

        // The Cloud's public page id (a 21-character nanoid). Caching it skips one
        // /status.json request per cycle.
        await queryInterface.addColumn('Statuspages', 'externalId', {
            type: Sequelize.STRING(64),
            allowNull: true,
            defaultValue: null,
        });

        await queryInterface.addColumn('Statuspages', 'detectedAt', {
            type: Sequelize.DATE,
            allowNull: true,
            defaultValue: null,
        });
    },

    async down(queryInterface) {
        await queryInterface.removeColumn('Statuspages', 'kind');
        await queryInterface.removeColumn('Statuspages', 'externalId');
        await queryInterface.removeColumn('Statuspages', 'detectedAt');
    },
};
