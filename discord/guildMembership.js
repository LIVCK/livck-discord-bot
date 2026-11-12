/**
 * Which guilds the bot is in, from the only source that knows: the gateway.
 *
 * KICKED WHILE RUNNING. Discord sends GUILD_DELETE when the bot is removed from a guild, the
 * guild is deleted, or the bot leaves it. discord.js tells that apart from an outage — a guild
 * that is merely unavailable arrives as `guildUnavailable`, not `guildDelete` — so this is a
 * definitive signal, and the guild's subscriptions are removed at once (their messages, links
 * and role mentions go with them by cascade). Whoever removed the bot does not expect it to
 * keep their setup, and without this every one of those channels would answer 50001 and sit
 * out a backoff for ever.
 *
 * KICKED WHILE OFFLINE. No event arrives for that. What does arrive is the list of every guild
 * the bot is in, at login. A subscription whose guild is not in it is SKIPPED — no request at
 * all — but not deleted, because a missing guild is exactly what a bot holding the wrong token
 * sees: a test bot pointed at the production database is in none of its guilds, and deleting
 * on that basis would wipe every subscription there is. Skipped, they cost nothing, and they
 * resume by themselves if the bot is invited back.
 *
 * One process, one gateway connection. Behind a ShardingManager each process would only see
 * its own shard's guilds and take every other guild for one it had left.
 */

import { Events } from 'discord.js';
import { setMembershipCheck } from '../util/delivery.js';
import logger from '../util/logger.js';

/**
 * @param {import('discord.js').Client} client
 * @param {{Subscription: {destroy: Function, findAll: Function}}} models
 */
export const watchGuildMembership = (client, models) => {
    // Before ready the cache is still filling, and every guild counts as joined.
    setMembershipCheck((guildId) => !client.isReady() || client.guilds.cache.has(guildId));

    client.on(Events.GuildDelete, async (guild) => {
        try {
            const removed = await models.Subscription.destroy({ where: { guildId: guild.id } });
            if (removed > 0) {
                logger.info(`[Discord] Removed from guild ${guild.id}; deleted its ${removed} subscription(s)`);
            }
        } catch (error) {
            // Not deleted now, but skipped from here on: the guild is no longer in the cache.
            logger.error(`[Discord] Removed from guild ${guild.id}; could not delete its subscriptions: ${error.message}`);
        }
    });

    client.once(Events.ClientReady, async () => {
        try {
            const rows = await models.Subscription.findAll({ attributes: ['guildId'] });
            const gone = new Set(rows.map((row) => row.guildId).filter((id) => id && !client.guilds.cache.has(id)));
            if (gone.size > 0) {
                const count = rows.filter((row) => gone.has(row.guildId)).length;
                logger.warn(
                    `[Discord] ${count} subscription(s) in ${gone.size} guild(s) the bot is not in; ` +
                    'skipped, not deleted (a bot holding the wrong token sees the same)'
                );
            }
        } catch (error) {
            logger.warn(`[Discord] Could not count subscriptions in guilds the bot left: ${error.message}`);
        }
    });
};

export default { watchGuildMembership };
