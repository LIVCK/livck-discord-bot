export default {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('Statuspages', {
            id: {
                allowNull: false,
                autoIncrement: true,
                primaryKey: true,
                type: Sequelize.INTEGER,
            },
            url: {
                type: Sequelize.STRING,
                allowNull: false,
                unique: true,
            },
            name: {
                type: Sequelize.STRING,
                allowNull: true,
            },
            lastChecked: {
                type: Sequelize.DATE,
            },
            createdAt: {
                allowNull: false,
                type: Sequelize.DATE,
            },
            updatedAt: {
                allowNull: false,
                type: Sequelize.DATE,
            },
        });

        await queryInterface.addIndex('Statuspages', ['url']);
    },

    async down(queryInterface) {
        await queryInterface.dropTable('Statuspages');
    },
};
