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
        /**
         * Hash of the last payload actually sent to Discord.
         *
         * The status message is re-rendered every cycle but changes only when the status
         * page does. Comparing hashes turns a constant stream of edits into one edit per
         * real change — which is what keeps the bot under Discord's 50 req/s ceiling.
         *
         * NULL on rows written before this column existed; that simply forces one edit.
         */
        contentHash: {
            type: DataTypes.STRING(64),
            allowNull: true,
            defaultValue: null,
        },
    });

    Message.associate = (models) => {
        Message.belongsTo(models.Subscription, { foreignKey: 'subscriptionId' });
    };


    return Message;
};
