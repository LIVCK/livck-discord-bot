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
         * Which kind of alert this message belongs to: incident, notice or maintenance.
         *
         * The Cloud's detail endpoint — the only way to recover an alert that has left the
         * live payload — returns a notice shaped exactly like an incident, with no field
         * saying which it is. Without remembering it here, a standing advisory came back days
         * later as a red incident with an outage severity, by editing the very message that
         * had been calm and blurple.
         *
         * NULL on rows written before this column existed, and on status messages.
         */
        kind: {
            type: DataTypes.STRING(16),
            allowNull: true,
            defaultValue: null,
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
