import models from '../models/index.js';
import { Op } from 'sequelize';

/**
 * Build role mention content and allowedMentions for a subscription's event type.
 * @param {number} subscriptionId
 * @param {string} eventType - 'STATUS' or 'NEWS'
 * @returns {Promise<{content: string, roleIds: string[], allowedMentions: object}>}
 */
export async function buildRoleMentions(subscriptionId, eventType) {
    const roleMentions = await models.RoleMention.findAll({
        where: {
            subscriptionId,
            eventType: { [Op.in]: ['ALL', eventType] }
        }
    });

    if (roleMentions.length === 0) {
        return { content: '', roleIds: [], allowedMentions: {} };
    }

    const roleIds = [...new Set(roleMentions.map(rm => rm.roleId))];
    const content = roleIds.map(id => `<@&${id}>`).join(' ');

    // IMPORTANT: Use roles array, NOT parse: ['roles']
    // parse and roles are mutually exclusive in the Discord API
    return {
        content,
        roleIds,
        allowedMentions: { roles: roleIds }
    };
}
