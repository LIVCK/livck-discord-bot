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

export const STATUS_EMOJIS = {
    // Status dots for compact layout
    GREEN_DOT: process.env.EMOJI_GREEN_DOT || '🟢',      // Fallback to Unicode
    RED_DOT: process.env.EMOJI_RED_DOT || '🔴',          // Fallback to Unicode
    ORANGE_DOT: process.env.EMOJI_ORANGE_DOT || '🟠',    // Fallback to Unicode

    // Animated status indicators (from existing bot config)
    STATUS_UP: '<a:status_up:1344187859921535047>',
    STATUS_DOWN: '<a:status_down:1344187930499088394>',
};

/**
 * Get status dot emoji based on status
 * @param {string} status - AVAILABLE, UNAVAILABLE, or DEGRADED
 * @returns {string} Emoji string
 */
export function getStatusDot(status) {
    switch (status) {
        case 'AVAILABLE':
            return STATUS_EMOJIS.GREEN_DOT;
        case 'UNAVAILABLE':
            return STATUS_EMOJIS.RED_DOT;
        case 'DEGRADED':
            return STATUS_EMOJIS.ORANGE_DOT;
        default:
            return '●';
    }
}

export default STATUS_EMOJIS;
