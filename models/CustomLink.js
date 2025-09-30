import { DataTypes } from "sequelize";

export default (sequelize) => {
    const CustomLink = sequelize.define('CustomLink', {
        subscriptionId: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'Subscriptions',
                key: 'id'
            }
        },
        label: {
            type: DataTypes.STRING(80),
            allowNull: false,
            validate: {
                len: [1, 80] // Discord button label limit
            }
        },
        url: {
            type: DataTypes.STRING(512),
            allowNull: false,
            validate: {
                isUrl: true
            }
        },
        emoji: {
            type: DataTypes.STRING(100),
            allowNull: true,
            defaultValue: null
        },
        position: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0
        }
    });

    CustomLink.associate = (models) => {
        CustomLink.belongsTo(models.Subscription, { foreignKey: 'subscriptionId', onDelete: 'CASCADE' });
    };

    return CustomLink;
};
