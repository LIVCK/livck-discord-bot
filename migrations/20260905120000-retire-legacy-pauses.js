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
 * the dead end. That means the first cycle after this deploy would pick every one of those rows
 * up, succeed, see `wasPaused`, and broadcast "▶️ Updates fortgesetzt — die Statusseite ist
 * wieder erreichbar" to every channel subscribed to it: the end of an outage those subscribers
 * were never told about, sometimes years old. All of it in a single cycle, 100 pages in
 * parallel, one `channel.send` per subscription — which is exactly the burst shape that puts a
 * bot near Discord's invalid-request ceiling and the Cloudflare ban behind it.
 *
 * So the legacy pauses are cleared here, before the loop ever sees them. A page that is still
 * broken simply climbs the new ladder and announces itself properly; a page that recovered
 * long ago comes back without shouting about it.
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
