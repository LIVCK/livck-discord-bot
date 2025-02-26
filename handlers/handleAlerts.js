import StatuspageService from "../services/statuspage.js";
import models from "../models/index.js";
import { EmbedBuilder } from 'discord.js';
import LIVCK from "../api/livck.js";
import { htmlToText } from "html-to-text";
import { truncate } from "../util/String.js";

export const handleAlerts = async (statuspageId, client) => {
    try {
        const statuspageRecord = await models.Statuspage.findOne({
            where: { id: statuspageId },
            include: [models.Subscription],
        });

        if (!statuspageRecord) {
            return;
        }

        const statuspageService = new StatuspageService(new LIVCK(statuspageRecord.url));
        await statuspageService.fetchAlerts();

        const alerts = statuspageService.alerts;

        for (const newsItem of alerts) {
            const embed = new EmbedBuilder()
                .setTitle(`${newsItem.title}`)
                .setDescription(truncate(htmlToText(newsItem.message), 500))
                .setURL(newsItem.link)
                .setTimestamp(new Date(newsItem.created_at))
                .setFooter({ text: statuspageRecord.name });

            if (newsItem.alerts.length > 0) {
                const alertDescriptions = newsItem.alerts.map(
                    (alert) => `**${alert.title}**\n${htmlToText(alert.message)}\n[Read More](${alert.link})`
                );
                embed.addFields([
                    {
                        name: "Updates",
                        value: truncate(alertDescriptions.join("\n\n"), 250),
                    }
                ]);
            }

            for (const subscription of statuspageRecord.Subscriptions) {
                if (!subscription.eventTypes.NEWS)
                    continue;

                // Prevent sending news items that were created before the subscription was created - only send new news items
                if (new Date(subscription.createdAt).getTime() > new Date(newsItem.created_at).getTime()) {
                    continue;
                }

                const channel = await client.channels.fetch(subscription.channelId);

                if (!channel) {
                    continue;
                }

                const existingMessage = await models.Message.findOne({
                    where: { subscriptionId: subscription.id, serviceId: newsItem.id, category: 'NEWS' },
                });

                if (existingMessage) {
                    try {
                        const message = await channel.messages.fetch(existingMessage.messageId);
                        await message.edit({ embeds: [embed] });
                    } catch (error) {
                        if (error.code === 10008) { // Message not found
                            await models.Message.destroy({
                                where: { subscriptionId: subscription.id, serviceId: newsItem.id, category: 'NEWS' },
                            });
                        }
                    }
                } else {
                    const message = await channel.send({ embeds: [embed] });
                    await models.Message.create({
                        subscriptionId: subscription.id,
                        messageId: message.id,
                        category: 'NEWS',
                        serviceId: newsItem.id,
                    });
                }
            }
        }
    } catch (error) {
        console.error(`Error processing news updates for statuspage ${statuspageId}: ${error.message}`, error);
    }
};
