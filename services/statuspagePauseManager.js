import LIVCK from '../api/livck.js';
import { EmbedBuilder, Colors } from 'discord.js';
import cache from '../database/redis.js';

const MAX_FAILURES = 3; // Nach 3 Fehlern wird pausiert
const FAILURE_WINDOW_MS = 5 * 60 * 1000; // 5 Minuten Fenster
const RESUME_COOLDOWN_MS = 60 * 1000; // 1 Minute Cooldown für Resume

export class StatuspagePauseManager {
    /**
     * Check if a statuspage should be paused and update accordingly
     * @param {Object} statuspage - Statuspage model instance
     * @param {Error} error - The error that occurred
     * @param {Object} client - Discord client for notifications
     * @param {Object} models - Sequelize models
     * @returns {Promise<boolean>} - true if paused, false otherwise
     */
    static async handleFailure(statuspage, error, client, models) {
        const now = new Date();

        // Reset failure count if last failure was too long ago
        if (statuspage.lastFailure) {
            const timeSinceLastFailure = now - new Date(statuspage.lastFailure);
            if (timeSinceLastFailure > FAILURE_WINDOW_MS) {
                statuspage.failureCount = 0;
            }
        }

        // Increment failure count
        statuspage.failureCount += 1;
        statuspage.lastFailure = now;

        // Determine pause reason
        let pauseReason = null;
        if (error.cause?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
            error.message?.includes('timeout') ||
            error.message?.includes('fetch failed')) {
            pauseReason = 'TIMEOUT';
        } else if (error.message?.includes('not a LIVCK') ||
                   error.message?.includes('lvk-version')) {
            pauseReason = 'NOT_LIVCK';
        }

        // Pause if reached failure threshold
        if (statuspage.failureCount >= MAX_FAILURES && pauseReason) {
            statuspage.paused = true;
            statuspage.pauseReason = pauseReason;
            await statuspage.save();

            console.warn(`[PauseManager] Paused ${statuspage.url} after ${statuspage.failureCount} failures (Reason: ${pauseReason})`);

            // Notify all subscriptions about the pause
            if (client && models) {
                await this.notifyPause(statuspage, pauseReason, client, models);
            }

            return true;
        }

        await statuspage.save();
        return false;
    }

    /**
     * Notify all subscriptions that a statuspage has been paused
     * @param {Object} statuspage - Statuspage model instance
     * @param {string} pauseReason - Reason for pause
     * @param {Object} client - Discord client
     * @param {Object} models - Sequelize models
     */
    static async notifyPause(statuspage, pauseReason, client, models) {
        try {
            const subscriptions = await models.Subscription.findAll({
                where: { statuspageId: statuspage.id }
            });

            const reasonText = {
                'TIMEOUT': 'Verbindungs-Timeouts / Connection timeouts',
                'NOT_LIVCK': 'Keine LIVCK-Statusseite mehr / No longer a LIVCK status page'
            };

            const embed = new EmbedBuilder()
                .setColor(Colors.Orange)
                .setTitle('⏸️ Status Page Updates Pausiert / Paused')
                .setDescription(
                    `Die Updates für **${statuspage.name || statuspage.url}** wurden automatisch pausiert.\n\n` +
                    `**Grund / Reason:** ${reasonText[pauseReason] || pauseReason}\n\n` +
                    `Updates wurden nach ${MAX_FAILURES} fehlgeschlagenen Versuchen pausiert. ` +
                    `Nutze \`/livck resume url:${statuspage.url}\` um die Updates fortzusetzen.\n\n` +
                    `Updates were paused after ${MAX_FAILURES} failed attempts. ` +
                    `Use \`/livck resume url:${statuspage.url}\` to resume updates.`
                )
                .setTimestamp();

            for (const subscription of subscriptions) {
                try {
                    const channel = await client.channels.fetch(subscription.channelId);
                    if (channel) {
                        await channel.send({ embeds: [embed] });
                    }
                } catch (error) {
                    console.error(`[PauseManager] Could not notify channel ${subscription.channelId}:`, error.message);
                }
            }
        } catch (error) {
            console.error(`[PauseManager] Error notifying about pause:`, error);
        }
    }

    /**
     * Validate if a statuspage is still a LIVCK instance
     * @param {string} url - Statuspage URL
     * @returns {Promise<boolean>} - true if valid LIVCK instance
     */
    static async validateLivckInstance(url) {
        try {
            const livck = new LIVCK(url);
            const isLivck = await livck.ensureIsLIVCK();
            return isLivck;
        } catch (error) {
            console.error(`[PauseManager] Error validating LIVCK instance ${url}:`, error.message);
            return false;
        }
    }

    /**
     * Resume a paused statuspage with full validation and rate limiting
     * @param {Object} statuspage - Statuspage model instance
     * @param {Object} models - Sequelize models
     * @returns {Promise<Object>} - Result object with success status and message
     */
    static async resume(statuspage, models) {
        if (!statuspage.paused) {
            return {
                success: false,
                message: 'Statuspage is not paused'
            };
        }

        // Check rate limiting (global per statuspage)
        const rateLimitKey = `resume:${statuspage.id}`;
        const lastResume = await cache.get(rateLimitKey);
        if (lastResume) {
            const remainingSeconds = Math.ceil((RESUME_COOLDOWN_MS - (Date.now() - parseInt(lastResume))) / 1000);
            return {
                success: false,
                message: `Please wait ${remainingSeconds} seconds before trying again`,
                rateLimited: true,
                remainingSeconds
            };
        }

        // Full validation: Check if statuspage is reachable and is LIVCK
        console.log(`[PauseManager] Validating ${statuspage.url} before resume...`);

        // 1. Check if it's a LIVCK instance
        const isLivck = await this.validateLivckInstance(statuspage.url);
        if (!isLivck) {
            return {
                success: false,
                message: 'Statuspage is not a valid LIVCK instance (missing lvk-version header)'
            };
        }

        // 2. Try to fetch categories to verify API is working
        try {
            const livck = new LIVCK(statuspage.url);
            const response = await livck.get('categories', { perPage: 1 });
            if (!response || (!response.data && !Array.isArray(response) && typeof response !== 'object')) {
                return {
                    success: false,
                    message: 'Statuspage API is not responding correctly'
                };
            }
        } catch (error) {
            return {
                success: false,
                message: `Statuspage is not reachable: ${error.message}`
            };
        }

        // All checks passed - resume
        statuspage.paused = false;
        statuspage.pauseReason = null;
        statuspage.failureCount = 0;
        statuspage.lastFailure = null;
        await statuspage.save();

        // Set rate limit
        await cache.set(rateLimitKey, Date.now().toString(), { EX: Math.ceil(RESUME_COOLDOWN_MS / 1000) });

        console.log(`[PauseManager] Successfully resumed ${statuspage.url}`);
        return {
            success: true,
            message: 'Statuspage resumed successfully and validated'
        };
    }

    /**
     * Get all paused statuspages for a guild
     * @param {Object} models - Sequelize models
     * @param {string} guildId - Discord guild ID
     * @returns {Promise<Array>} - Array of paused statuspages
     */
    static async getPausedForGuild(models, guildId) {
        const statuspages = await models.Statuspage.findAll({
            where: { paused: true },
            include: [{
                model: models.Subscription,
                where: { guildId },
                required: true
            }]
        });

        return statuspages;
    }
}

export default StatuspagePauseManager;
