export default {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('Messages', {
            id: {
                allowNull: false,
                autoIncrement: true,
                primaryKey: true,
                type: Sequelize.INTEGER,
            },
            subscriptionId: {
                type: Sequelize.INTEGER,
                references: {
                    model: 'Subscriptions',
                    key: 'id',
                },
                onDelete: 'CASCADE',
            },
            messageId: {
                type: Sequelize.STRING,
            },
            serviceId: {
                type: Sequelize.STRING,
            },
            category: {
                type: Sequelize.STRING,
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

        await queryInterface.addIndex('Messages', ['subscriptionId']);
    },
    async down(queryInterface) {
        await queryInterface.dropTable('Messages');
    },
};
