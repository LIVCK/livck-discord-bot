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

        const statuspageService = new StatuspageService(new LIVCK(statuspageRecord.url));
        await statuspageService.fetchAll();

        const embed = generateEmbed(statuspageService, statuspageRecord);

        await Promise.all(statuspageRecord.Subscriptions.map(async (subscription) => {
            if (!subscription.eventTypes.STATUS)
                return;

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
        }));
    } catch (error) {
        console.error(`Error processing status updates for statuspage ${statuspageId}: ${error.message}`, error);
    }
};
