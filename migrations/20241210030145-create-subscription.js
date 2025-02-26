export default {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('Subscriptions', {
            id: {
                allowNull: false,
                autoIncrement: true,
                primaryKey: true,
                type: Sequelize.INTEGER,
            },
            guildId: {
                type: Sequelize.STRING,
                allowNull: false,
            },
            channelId: {
                type: Sequelize.STRING,
                allowNull: false,
            },
            statuspageId: {
                type: Sequelize.INTEGER,
                references: {
                    model: 'Statuspages',
                    key: 'id',
                },
                onDelete: 'CASCADE',
            },
            eventTypes: {
                type: Sequelize.JSON,
                allowNull: false,
                defaultValue: { STATUS: true, NEWS: false },
            },
            interval: {
                type: Sequelize.INTEGER,
                allowNull: false,
            },
            pausedUntil: {
                type: Sequelize.DATE,
            },
            registeredAt: {
                type: Sequelize.DATE,
                allowNull: false,
                defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
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

        // UNIQUE-Constraint
        await queryInterface.addConstraint('Subscriptions', {
            fields: ['guildId', 'channelId', 'statuspageId'],
            type: 'unique',
            name: 'unique_guild_channel_statuspage',
        });

        await queryInterface.addIndex('Subscriptions', ['statuspageId']);
    },

    async down(queryInterface) {
        await queryInterface.dropTable('Subscriptions');
    },
};
