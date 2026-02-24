export default {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('RoleMentions', {
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
            roleId: {
                type: Sequelize.STRING(20),
                allowNull: false
            },
            eventType: {
                type: Sequelize.STRING(10),
                allowNull: false,
                defaultValue: 'ALL'
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
        await queryInterface.addIndex('RoleMentions', ['subscriptionId']);

        // Unique constraint: same role + event type per subscription
        await queryInterface.addIndex('RoleMentions', ['subscriptionId', 'roleId', 'eventType'], {
            unique: true
        });
    },

    async down(queryInterface) {
        await queryInterface.dropTable('RoleMentions');
    }
};
