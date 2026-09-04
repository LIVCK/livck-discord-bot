/**
 * Rollout switches.
 *
 * These exist so a branch can be merged and deployed before every part of it is finished,
 * and so the way back is a restart rather than a revert.
 */

const enabled = (name, fallback = false) => {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
};

/**
 * Accept LIVCK Cloud status pages.
 *
 * Off by default. Cloud STATUS rendering is complete, but Cloud NEWS still has a known gap:
 * the Cloud drops an incident from `active_incidents` the moment it is resolved, so the
 * closing update never reaches Discord and a thread would sit on "we are monitoring" forever.
 * Turn this on once that is closed — see the `recently_closed` work.
 *
 * Only affects NEW subscriptions; self-hosted pages are unaffected either way.
 */
export const CLOUD_ENABLED = () => enabled('CLOUD_ENABLED', false);

export default { CLOUD_ENABLED };
