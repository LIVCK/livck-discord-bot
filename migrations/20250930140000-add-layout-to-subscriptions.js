export default {
    async up(queryInterface, Sequelize) {
        // Add layout column to Subscriptions table
        await queryInterface.addColumn('Subscriptions', 'layout', {
            type: Sequelize.STRING(50),
            allowNull: false,
            defaultValue: 'DETAILED',
        });
    },

    async down(queryInterface) {
        // Remove layout column
        await queryInterface.removeColumn('Subscriptions', 'layout');
    },
};
