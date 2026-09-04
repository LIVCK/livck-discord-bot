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
        /**
         * Why updates are paused — one of util/errors.js FAILURE_KINDS.
         *
         * Deliberately a STRING and not an ENUM: the set of failure kinds grows (it already
         * gained DNS, TLS and the HTTP families, and the Cloud will add more), and every
         * widening of an ENUM is a table alter on a live table.
         */
        pauseReason: {
            type: DataTypes.STRING(32),
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
        /** Current rung of the backoff ladder (see services/statuspagePauseManager.js). */
        backoffLevel: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0,
        },
        /** Earliest time the update loop may try this page again; NULL = immediately. */
        nextAttemptAt: {
            type: DataTypes.DATE,
            allowNull: true,
            defaultValue: null,
        },
        /**
         * Which product this page runs — 'CLOUD' or 'SELF_HOSTED'.
         *
         * NULL means "not probed yet", which is how rows created before this feature migrate
         * themselves: the first cycle detects and stores it. A STRING rather than an ENUM,
         * for the same reason as pauseReason.
         */
        kind: {
            type: DataTypes.STRING(16),
            allowNull: true,
            defaultValue: null,
        },
        /** The Cloud page id, cached so the /status.json lookup happens only once. */
        externalId: {
            type: DataTypes.STRING(64),
            allowNull: true,
            defaultValue: null,
        },
        detectedAt: {
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
