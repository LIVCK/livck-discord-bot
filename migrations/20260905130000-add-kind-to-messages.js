/**
 * Remember what KIND of alert a tracked message belongs to.
 *
 * The Cloud drops a resolved alert from the live payload, and the bot recovers the ending from
 * the detail endpoint. That endpoint returns a notice shaped exactly like an incident — the
 * live listing keeps the two apart with a service-state filter precisely so a notice never
 * carries a severity badge, and the detail route has no such filter, and emits no field that
 * says which it is.
 *
 * So a standing advisory ("phishing mails are going around" — posted calm and blurple, no
 * severity, no ping) came back days later as a RED incident with an outage severity, by
 * editing the very message that had been calm. The bot has to carry the answer itself.
 *
 * Nullable with no default, like every other column added for the Cloud rollout: an existing
 * row means "posted before this shipped" and simply keeps today's behaviour. No backfill —
 * the alerts those rows point at are outside the reporting window within days anyway.
 */
const addColumnIfMissing = async (queryInterface, table, column, definition) => {
    const columns = await queryInterface.describeTable(table);
    if (columns[column]) return;
    await queryInterface.addColumn(table, column, definition);
};

const dropColumn = async (queryInterface, table, column) => {
    const columns = await queryInterface.describeTable(table);
    if (!columns[column]) return;
    // Not `removeColumn`: it cannot run on this stack at all. See the other migrations.
    await queryInterface.sequelize.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
};

export default {
    async up(queryInterface, Sequelize) {
        // 'incident' | 'notice' | 'maintenance' | null — a STRING for the same reason
        // pauseReason is one: the set grows, and widening an ENUM is a table alter every time.
        await addColumnIfMissing(queryInterface, 'Messages', 'kind', {
            type: Sequelize.STRING(16),
            allowNull: true,
            defaultValue: null,
        });
    },

    async down(queryInterface) {
        await dropColumn(queryInterface, 'Messages', 'kind');
    },
};
