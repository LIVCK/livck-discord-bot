export default {
    async up(queryInterface, Sequelize) {
        await queryInterface.addColumn('Statuspages', 'paused', {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: false,
        });

        await queryInterface.addColumn('Statuspages', 'pauseReason', {
            type: Sequelize.ENUM('TIMEOUT', 'NOT_LIVCK', 'MANUAL'),
            allowNull: true,
            defaultValue: null,
        });

        await queryInterface.addColumn('Statuspages', 'failureCount', {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 0,
        });

        await queryInterface.addColumn('Statuspages', 'lastFailure', {
            type: Sequelize.DATE,
            allowNull: true,
            defaultValue: null,
        });
    },

    async down(queryInterface) {
        await queryInterface.removeColumn('Statuspages', 'paused');
        await queryInterface.removeColumn('Statuspages', 'pauseReason');
        await queryInterface.removeColumn('Statuspages', 'failureCount');
        await queryInterface.removeColumn('Statuspages', 'lastFailure');
    },
};
