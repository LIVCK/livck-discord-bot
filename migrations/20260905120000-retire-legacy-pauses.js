/**
 * Retire the pauses the OLD code left behind, quietly.
 *
 * Until this branch, `server.js` hard-filtered paused pages out of the cycle
 * (`const activePages = statuspages.filter(sp => !sp.paused)`), so a pause was a dead end that
 * only `/livck resume` could clear — and the old code never told subscribers a page had paused
 * in the first place. Rows therefore accumulate: every status page that ever had a bad day and
 * nobody noticed is still sitting there with `paused = 1`, possibly for years.
 *
 * The new loop deliberately no longer filters on `paused`, because the backoff ladder replaced
 * the dead end — so the first cycle after this deploy picks every one of those rows up again.
 * Left alone they would each carry a stale `pauseReason` and `failureCount` from an outage
 * that may be years old, and `handleSuccess` would write to every one of them on the same
 * cycle. Clearing them up front means the new state machine starts from a clean slate: a page
 * that is still broken climbs the ladder from level zero, and one that recovered long ago is
 * simply healthy.
 *
 * (An earlier version of this branch also broadcast a "back online" embed into every
 * subscribed channel on recovery, which would have made this migration urgent rather than
 * tidy. That message is gone — an outage is now a line in the footer of the status message
 * that is already there, and coming back is announced by nothing at all.)
 *
 * Only rows the OLD code paused are touched. Anything the new state machine paused carries a
 * `backoffLevel` of at least NOTIFY_AT_LEVEL, so `backoffLevel = 0` identifies the legacy ones
 * exactly.
 */
import { QueryTypes } from 'sequelize';

/**
 * A RAW SELECT MUST NAME ITS TYPE ON THIS STACK.
 *
 * Sequelize 6.37's mariadb integration does `delete data.meta` on the driver's result, and the
 * mariadb 3.4 driver returns a rows array whose `meta` is non-configurable — so an untyped
 * `sequelize.query('SELECT …')` throws `Cannot delete property 'meta' of [object Array]` before
 * it can return anything. `{ type: QueryTypes.SELECT }` takes a different path and works.
 * UPDATE and ALTER TABLE are unaffected either way. Verified on this database.
 */
export default {
    async up(queryInterface) {
        const [row] = await queryInterface.sequelize.query(
            'SELECT COUNT(*) AS count FROM Statuspages WHERE paused = 1 AND (backoffLevel IS NULL OR backoffLevel = 0)',
            { type: QueryTypes.SELECT }
        );
        const count = Number(row?.count ?? 0);

        if (count === 0) {
            console.log('[migration] No legacy pauses to retire.');
            return;
        }

        await queryInterface.sequelize.query(`
            UPDATE Statuspages
               SET paused = 0,
                   pauseReason = NULL,
                   failureCount = 0,
                   lastFailure = NULL
             WHERE paused = 1
               AND (backoffLevel IS NULL OR backoffLevel = 0)
        `);

        console.log(
            `[migration] Retired ${count} pause(s) left by the old update loop. ` +
            'A page that is still unreachable will pause itself again through the backoff ladder ' +
            'and tell its subscribers properly; one that recovered stays quiet.'
        );
    },

    async down() {
        // Deliberately a no-op. Which rows were paused, and why, is not recorded anywhere, so
        // there is nothing to restore — and restoring them would only re-arm the broadcast this
        // migration exists to prevent. The state is reconstructed by the loop within one
        // backoff cycle anyway.
    },
};
