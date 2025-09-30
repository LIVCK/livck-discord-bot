import { DataTypes } from "sequelize";

export default (sequelize) => {
    const Subscription = sequelize.define('Subscription', {
        guildId: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        channelId: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        locale: {
            type: DataTypes.STRING(5),
            allowNull: false,
            defaultValue: 'de',
            validate: {
                isIn: [['de', 'en']]
            }
        },
        eventTypes: {
            type: DataTypes.JSON,
            allowNull: false,
            defaultValue: { STATUS: true, NEWS: false },
        },
        layout: {
            type: DataTypes.STRING(50),
            allowNull: false,
            defaultValue: 'DETAILED',
        },
        interval: {
            type: DataTypes.INTEGER,
            allowNull: false,
        },
        pausedUntil: {
            type: DataTypes.DATE,
        },
        registeredAt: {
            type: DataTypes.DATE,
            allowNull: false,
            defaultValue: DataTypes.NOW,
        },
    });

    Subscription.associate = (models) => {
        Subscription.belongsTo(models.Statuspage, { foreignKey: 'statuspageId' });
        Subscription.hasMany(models.Message, { foreignKey: 'subscriptionId', onDelete: 'CASCADE' });
        Subscription.hasMany(models.CustomLink, { foreignKey: 'subscriptionId', onDelete: 'CASCADE' });
    };

    return Subscription;
};
