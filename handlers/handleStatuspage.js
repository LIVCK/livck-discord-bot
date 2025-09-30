import StatuspageService from "../services/statuspage.js";
import models from "../models/index.js";
import { generateEmbed } from "../messages/messageHelper.js";
import LIVCK from "../api/livck.js";

export const handleStatusPage = async (statuspageId, client) => {
    try {
        const statuspageRecord = await models.Statuspage.findOne({
            where: { id: statuspageId },
            include: [models.Subscription],
        });

        if (!statuspageRecord) {
            return;
        }

        console.log('[handleStatusPage] Processing statuspage:', statuspageRecord.url);
        console.log('[handleStatusPage] Subscriptions count:', statuspageRecord.Subscriptions?.length || 0);

        const statuspageService = new StatuspageService(new LIVCK(statuspageRecord.url));

        try {
            await statuspageService.fetchAll();
        } catch (fetchError) {
            console.error('[handleStatusPage] Error in fetchAll:', fetchError);
        }

        console.log('[handleStatusPage] Fetched categories:', statuspageService.categories?.length || 0);
        if (statuspageService.categories?.length === 0) {
            console.warn('[handleStatusPage] No categories fetched for', statuspageRecord.url);
        }

        await Promise.all(statuspageRecord.Subscriptions.map(async (subscription) => {
            try {
                if (!subscription.eventTypes.STATUS)
                    return;

                // Generate embed with subscription's locale
                const embed = generateEmbed(statuspageService, statuspageRecord, subscription.locale);
                console.log('[handleStatusPage] Generated embed fields:', embed.data.fields?.length || 0);

                const channel = await client.channels.fetch(subscription.channelId);

                if (!channel) {
                    return;
                }

                const existingMessage = await models.Message.findOne({
                    where: { subscriptionId: subscription.id, category: 'STATUS' },
                });

                if (existingMessage) {
                    try {
                        const message = await channel.messages.fetch(existingMessage.messageId);
                        await message.edit({ embeds: [embed] });
                    } catch (error) {
                        if (error.code === 10008) {
                            await models.Message.destroy({
                                where: { subscriptionId: subscription.id, category: 'STATUS' },
                            });
                        }
                    }
                } else {
                    const message = await channel.send({ embeds: [embed] });
                    await models.Message.create({
                        subscriptionId: subscription.id,
                        messageId: message.id,
                        category: 'STATUS',
                    });
                }
            } catch (error) {
                if (error.code === 10003) {
                    console.warn(`[Discord] Unknown channel ${subscription.channelId}, deleting subscription ${subscription.id}`);
                    await models.Subscription.destroy({ where: { id: subscription.id } });
                } else if (error.code === 50001) {
                    console.warn(`[Discord] Missing access to channel ${subscription.channelId}, deleting subscription ${subscription.id}`);
                    await models.Subscription.destroy({ where: { id: subscription.id } });
                } else {
                    throw error;
                }
            }
        }));
    } catch (error) {
        console.error(`Error processing status updates for statuspage ${statuspageId}: ${error.message}`, error);
    }
};
