/**
 * Which guilds the bot is in, from the only source that knows: the gateway.
 *
 * KICKED WHILE CONNECTED. Discord sends GUILD_DELETE when the bot is removed from a guild, the
 * guild is deleted, or the bot leaves it. An outage arrives as the same packet with
 * `unavailable: true`, so this is a definitive signal, and the guild's subscriptions are removed
 * at once (their messages, links and role mentions go with them by cascade). Whoever removed the
 * bot does not expect it to keep their setup.
 *
 * KICKED WHILE NOT CONNECTED — offline, or in the seconds a dropped gateway connection takes to
 * come back. No GUILD_DELETE arrives for that. What does arrive is the list of every guild the
 * bot is in, with every READY. A subscription whose guild is not in it is SKIPPED — no request at
 * all — but not deleted, because a missing guild is exactly what a bot holding the wrong token
 * sees: a test bot pointed at the production database is in none of its guilds, and deleting on
 * that basis would wipe every subscription there is. Skipped, they cost nothing, and they resume
 * by themselves if the bot is invited back.
 *
 * THE LIST IS KEPT HERE, NOT READ FROM discord.js's CACHE. discord.js adds what a READY lists but
 * never removes what it no longer lists, so after a reconnect a guild the bot was thrown out of
 * in the meantime stayed in `client.guilds.cache` for good, and the bot kept asking it. The
 * simulation in __tests__/sim found that: a kick during a gateway drop. Each READY here replaces
 * the list outright.
 *
 * One process, one gateway connection. Behind a ShardingManager each process would only see its
 * own shard's guilds and take every other guild for one it had left.
 */

import { Events } from 'discord.js';
import { setMembershipCheck } from '../util/delivery.js';
import logger from '../util/logger.js';

/**
 * @param {import('discord.js').Client} client
 * @param {{Subscription: {destroy: Function, findAll: Function}}} models
 */
export const watchGuildMembership = (client, models) => {
    /** null until the first READY: until then every guild counts as joined. */
    let member = null;

    setMembershipCheck((guildId) => member === null || member.has(guildId));

    const countMissing = async () => {
        try {
            const rows = await models.Subscription.findAll({ attributes: ['guildId'] });
            const gone = new Set(rows.map((row) => row.guildId).filter((id) => id && !member.has(id)));
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
    };

    client.on(Events.Raw, (packet) => {
        const data = packet?.d;
        if (!data) return;
        if (packet.t === 'READY') {
            const first = member === null;
            member = new Set((data.guilds ?? []).map((guild) => guild.id));
            if (first) countMissing();
        } else if (packet.t === 'GUILD_CREATE') {
            member?.add(data.id);
        } else if (packet.t === 'GUILD_DELETE' && !data.unavailable) {
            member?.delete(data.id);
        }
    });

    client.on(Events.GuildDelete, async (guild) => {
        try {
            const removed = await models.Subscription.destroy({ where: { guildId: guild.id } });
            if (removed > 0) {
                logger.info(`[Discord] Removed from guild ${guild.id}; deleted its ${removed} subscription(s)`);
            }
        } catch (error) {
            // Not deleted now, but skipped from here on: the guild is no longer in the list.
            logger.error(`[Discord] Removed from guild ${guild.id}; could not delete its subscriptions: ${error.message}`);
        }
    });
};

export default { watchGuildMembership };
