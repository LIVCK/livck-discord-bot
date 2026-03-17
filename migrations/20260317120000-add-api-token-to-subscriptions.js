export default {
    async up(queryInterface, Sequelize) {
        await queryInterface.addColumn('Subscriptions', 'apiToken', {
            type: Sequelize.STRING,
            allowNull: true,
            defaultValue: null,
        });
    },

    async down(queryInterface) {
        await queryInterface.removeColumn('Subscriptions', 'apiToken');
    },
};
