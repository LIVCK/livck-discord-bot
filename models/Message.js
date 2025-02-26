import { DataTypes } from "sequelize";

export default (sequelize) => {
    const Message = sequelize.define('Message', {
        subscriptionId: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'Subscriptions',
                key: 'id',
            },
            onDelete: 'CASCADE',
        },
        messageId: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        serviceId: {
            type: DataTypes.STRING,
            allowNull: true,
        },
        category: {
            type: DataTypes.STRING,
            allowNull: false,
            defaultValue: 'STATUS'
        },
    });

    Message.associate = (models) => {
        Message.belongsTo(models.Subscription, { foreignKey: 'subscriptionId' });
    };


    return Message;
};
