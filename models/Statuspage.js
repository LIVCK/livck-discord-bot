import { DataTypes } from "sequelize";

export default (sequelize) => {
    const Statuspage = sequelize.define('Statuspage', {
        url: {
            type: DataTypes.STRING,
            allowNull: false,
            unique: true,
        },
        name: {
            type: DataTypes.STRING,
            allowNull: true,
        },
        lastChecked: {
            type: DataTypes.DATE,
        },
    });

    Statuspage.associate = (models) => {
        Statuspage.hasMany(models.Subscription, { foreignKey: 'statuspageId', onDelete: 'CASCADE' });
    };

    return Statuspage;
};
