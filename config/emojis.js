/**
 * Custom Emoji Configuration
 *
 * To set up custom emojis:
 * 1. Upload the PNG files from assets/emojis/ to your Discord server
 * 2. Get the emoji IDs by typing \:emoji_name: in Discord
 * 3. Update the IDs below
 *
 * Format: <:name:id> or <a:name:id> for animated
 */

import { STATUS } from '../dto/statuspage.js';

export const STATUS_EMOJIS = {
    // Status dots for compact layout
    GREEN_DOT: process.env.EMOJI_GREEN_DOT || '🟢',      // Fallback to Unicode
    RED_DOT: process.env.EMOJI_RED_DOT || '🔴',          // Fallback to Unicode
    ORANGE_DOT: process.env.EMOJI_ORANGE_DOT || '🟠',    // Fallback to Unicode
    // Only the Cloud has a maintenance state; there is no uploadable asset for it, so this
    // stays Unicode-only rather than adding a fourth EMOJI_* variable nobody would set.
    BLUE_DOT: process.env.EMOJI_BLUE_DOT || '🔵',

    // Animated status indicators (from existing bot config)
    STATUS_UP: '<a:status_up:1344187859921535047>',
    STATUS_DOWN: '<a:status_down:1344187930499088394>',
};

/**
 * Get status dot emoji based on a DTO status.
 *
 * `partial_outage` shares amber with `degraded` on purpose: a self-hosted page has only three
 * states, and folding the Cloud's extra one into the same colour keeps a page that migrates
 * from self-hosted to Cloud looking the same.
 *
 * @param {string} status - one of dto/statuspage.js STATUS
 * @returns {string} Emoji string
 */
export function getStatusDot(status) {
    switch (status) {
        case STATUS.OPERATIONAL:
            return STATUS_EMOJIS.GREEN_DOT;
        case STATUS.MAJOR_OUTAGE:
            return STATUS_EMOJIS.RED_DOT;
        case STATUS.DEGRADED:
        case STATUS.PARTIAL_OUTAGE:
            return STATUS_EMOJIS.ORANGE_DOT;
        case STATUS.UNDER_MAINTENANCE:
        case STATUS.MAINTENANCE:
            return STATUS_EMOJIS.BLUE_DOT;
        default:
            return '●';
    }
}

export default STATUS_EMOJIS;
