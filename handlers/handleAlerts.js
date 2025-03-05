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

        for (const newsItem of alerts) {
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

            for (const subscription of statuspageRecord.Subscriptions) {
                if (!subscription.eventTypes.NEWS) continue;

                if (new Date(subscription.createdAt).getTime() > new Date(newsItem.created_at).getTime()) {
                    continue;
                }

                const channel = await client.channels.fetch(subscription.channelId);

                if (!channel) {
                    continue;
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
                } else {
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
            }
        }
    } catch (error) {
        console.error(`Error processing alerts for statuspage ${statuspageId}: ${error.message}`, error);
    }
};
