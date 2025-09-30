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
        paused: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false,
        },
        pauseReason: {
            type: DataTypes.ENUM('TIMEOUT', 'NOT_LIVCK'),
            allowNull: true,
            defaultValue: null,
        },
        failureCount: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0,
        },
        lastFailure: {
            type: DataTypes.DATE,
            allowNull: true,
            defaultValue: null,
        },
    });

    Statuspage.associate = (models) => {
        Statuspage.hasMany(models.Subscription, { foreignKey: 'statuspageId', onDelete: 'CASCADE' });
    };

    return Statuspage;
};
