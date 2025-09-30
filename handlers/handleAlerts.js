import StatuspageService from "../services/statuspage.js";
import models from "../models/index.js";
import { EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle, Colors } from 'discord.js';
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

        const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
        const now = Date.now();

        const recentAlerts = alerts.filter(newsItem => {
            const alertAge = now - new Date(newsItem.created_at).getTime();
            return alertAge <= THREE_DAYS_MS;
        });

        await Promise.all(recentAlerts.map(async (newsItem) => {
            let color = Colors.Blurple;
            if (newsItem.type === 'INCIDENT') {
                color = Colors.Red;
            } else if (newsItem.scheduled_for) {
                color = Colors.Yellow;
            }

            const embed = new EmbedBuilder()
                .setColor(color)
                .setTitle(newsItem.title)
                .setDescription(truncate(htmlToText(newsItem.message), 500))
                .setURL(newsItem.link)
                .setTimestamp(new Date(newsItem.created_at))
                .setFooter({ text: statuspageRecord.name });

            const button = new ButtonBuilder()
                .setLabel('Ansehen')
                .setStyle(ButtonStyle.Link)
                .setURL(newsItem.link);

            const row = new ActionRowBuilder().addComponents(button);

            await Promise.all(statuspageRecord.Subscriptions.map(async (subscription) => {
                try {
                    if (!subscription.eventTypes.NEWS) return;

                    if (new Date(subscription.createdAt).getTime() > new Date(newsItem.created_at).getTime()) {
                        return;
                    }

                    const channel = await client.channels.fetch(subscription.channelId);

                    if (!channel) {
                        return;
                    }

                let mainMessage = await models.Message.findOne({
                    where: { subscriptionId: subscription.id, serviceId: newsItem.id, category: 'NEWS' },
                });

                if (mainMessage) {
                    try {
                        mainMessage = await channel.messages.fetch(mainMessage.messageId);
                        await mainMessage.edit({ embeds: [embed], components: [row] });
                    } catch (error) {
                        if (error.code === 10008) {
                            await models.Message.destroy({
                                where: { subscriptionId: subscription.id, serviceId: newsItem.id, category: 'NEWS' },
                            });
                            mainMessage = null;
                        }
                    }
                }

                if (!mainMessage) {
                    mainMessage = await channel.send({ embeds: [embed], components: [row] });
                    await models.Message.create({
                        subscriptionId: subscription.id,
                        messageId: mainMessage.id,
                        category: 'NEWS',
                        serviceId: newsItem.id,
                    });
                }

                for (const subAlert of newsItem.alerts) {
                    const existingSubAlertMessage = await models.Message.findOne({
                        where: { subscriptionId: subscription.id, serviceId: subAlert.id, category: 'ALERT' },
                    });

                    const subAlertEmbed = new EmbedBuilder()
                        .setColor(color)
                        .setTitle(subAlert.title)
                        .setDescription(truncate(htmlToText(subAlert.message), 500))
                        .setURL(newsItem.link)
                        .setTimestamp(new Date(subAlert.created_at))
                        .setFooter({ text: statuspageRecord.name });

                    const button = new ButtonBuilder()
                        .setLabel('Zum Update')
                        .setStyle(ButtonStyle.Link)
                        .setURL(newsItem.link);

                    const row = new ActionRowBuilder().addComponents(button);

                    if (existingSubAlertMessage) {
                        try {
                            const message = await channel.messages.fetch(existingSubAlertMessage.messageId);
                            await message.edit({ embeds: [subAlertEmbed], components: [row] });
                        } catch (error) {
                            if (error.code === 10008) {
                                await models.Message.destroy({
                                    where: { subscriptionId: subscription.id, serviceId: subAlert.id, category: 'ALERT' },
                                });
                            }
                        }
                    } else {
                        const subAlertMessage = await mainMessage.reply({ embeds: [subAlertEmbed], components: [row] });
                        await models.Message.create({
                            subscriptionId: subscription.id,
                            messageId: subAlertMessage.id,
                            category: 'ALERT',
                            serviceId: subAlert.id,
                        });
                    }
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
        }));
    } catch (error) {
        console.error(`Error processing alerts for statuspage ${statuspageId}: ${error.message}`, error);
    }
};
