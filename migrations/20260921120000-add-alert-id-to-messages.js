/**
 * Remember which ROOT ALERT a tracked message belongs to.
 *
 * `serviceId` already identifies the thing a row was rendered from — but for a reply that is
 * the UPDATE's id, not the alert's, and nothing in the table connects the two. That was fine
 * while a thread was only ever edited: the parent is found by the alert id, each reply by its
 * own update id, and neither needs to know about the other.
 *
 * Deleting a thread does. When an alert is removed from the status page the bot removes the
 * thread it posted — and a thread is a parent plus every reply hanging off it. Without this
 * column the replies cannot be enumerated: the alert is gone from the API, so its update ids
 * are gone with it, and the only alternative would be deleting the parent and leaving the
 * replies behind as "Original message was deleted".
 *
 * Nullable with no default, like every other column added for the Cloud rollout. A row without
 * it was written before this shipped, and the deletion path deliberately refuses to act on
 * one — see `removeAlertThread`. No backfill is needed or possible: the close-out only ever
 * looks at rows inside the three-day reporting window, so every row it can reach carries the
 * column within three days of deploying this.
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
        await addColumnIfMissing(queryInterface, 'Messages', 'alertId', {
            type: Sequelize.STRING,
            allowNull: true,
            defaultValue: null,
        });
    },

    async down(queryInterface) {
        await dropColumn(queryInterface, 'Messages', 'alertId');
    },
};
