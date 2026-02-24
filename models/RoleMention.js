import { DataTypes } from "sequelize";

export default (sequelize) => {
    const RoleMention = sequelize.define('RoleMention', {
        subscriptionId: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'Subscriptions',
                key: 'id'
            }
        },
        roleId: {
            type: DataTypes.STRING(20),
            allowNull: false
        },
        eventType: {
            type: DataTypes.STRING(10),
            allowNull: false,
            defaultValue: 'ALL',
            validate: {
                isIn: [['ALL', 'STATUS', 'NEWS']]
            }
        }
    });

    RoleMention.associate = (models) => {
        RoleMention.belongsTo(models.Subscription, { foreignKey: 'subscriptionId', onDelete: 'CASCADE' });
    };

    return RoleMention;
};
