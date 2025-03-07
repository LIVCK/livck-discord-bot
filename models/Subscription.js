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
        eventTypes: {
            type: DataTypes.JSON,
            allowNull: false,
            defaultValue: { STATUS: true, NEWS: false },
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
    };

    return Subscription;
};
