export default {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('CustomLinks', {
            id: {
                type: Sequelize.INTEGER,
                primaryKey: true,
                autoIncrement: true,
                allowNull: false
            },
            subscriptionId: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: {
                    model: 'Subscriptions',
                    key: 'id'
                },
                onDelete: 'CASCADE',
                onUpdate: 'CASCADE'
            },
            label: {
                type: Sequelize.STRING(80),
                allowNull: false
            },
            url: {
                type: Sequelize.STRING(512),
                allowNull: false
            },
            emoji: {
                type: Sequelize.STRING(100),
                allowNull: true,
                defaultValue: null
            },
            position: {
                type: Sequelize.INTEGER,
                allowNull: false,
                defaultValue: 0
            },
            createdAt: {
                type: Sequelize.DATE,
                allowNull: false
            },
            updatedAt: {
                type: Sequelize.DATE,
                allowNull: false
            }
        });

        // Add index for faster lookups
        await queryInterface.addIndex('CustomLinks', ['subscriptionId']);
    },

    async down(queryInterface) {
        await queryInterface.dropTable('CustomLinks');
    }
};
