import StatuspageService from "../services/statuspage.js";
import models from "../models/index.js";
import { EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle, Colors } from 'discord.js';
import LIVCK from "../api/livck.js";
import { htmlToText } from "html-to-text";
import { truncate } from "../util/String.js";

// Convert HTML to Discord Markdown
const convertHtmlToMarkdown = (html) => {
    if (!html) return '';

    let text = html;

    // Convert HTML tags to Discord markdown
    text = text.replace(/<strong>(.*?)<\/strong>/gi, '**$1**');           // Bold
    text = text.replace(/<b>(.*?)<\/b>/gi, '**$1**');                     // Bold (b tag)
    text = text.replace(/<em>(.*?)<\/em>/gi, '*$1*');                     // Italic
    text = text.replace(/<i>(.*?)<\/i>/gi, '*$1*');                       // Italic (i tag)
    text = text.replace(/<s>(.*?)<\/s>/gi, '~~$1~~');                     // Strikethrough
    text = text.replace(/<del>(.*?)<\/del>/gi, '~~$1~~');                 // Strikethrough (del tag)
    text = text.replace(/<code>(.*?)<\/code>/gi, '`$1`');                 // Inline code
    text = text.replace(/<mark>(.*?)<\/mark>/gi, '**$1**');               // Marked (as bold, Discord has no highlight)
    text = text.replace(/<u>(.*?)<\/u>/gi, '__$1__');                     // Underline

    // Headings
    text = text.replace(/<h1>(.*?)<\/h1>/gi, '\n**$1**\n');               // H1 as bold
    text = text.replace(/<h2>(.*?)<\/h2>/gi, '\n**$1**\n');               // H2 as bold
    text = text.replace(/<h3>(.*?)<\/h3>/gi, '\n**$1**\n');               // H3 as bold
    text = text.replace(/<h4>(.*?)<\/h4>/gi, '\n**$1**\n');               // H4 as bold
    text = text.replace(/<h5>(.*?)<\/h5>/gi, '\n**$1**\n');               // H5 as bold
    text = text.replace(/<h6>(.*?)<\/h6>/gi, '\n**$1**\n');               // H6 as bold

    // Links
    text = text.replace(/<a\s+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, '[$2]($1)');

    // Lists
    text = text.replace(/<li>(.*?)<\/li>/gi, '• $1\n');                   // List items
    text = text.replace(/<\/?ul>/gi, '\n');                               // Unordered lists
    text = text.replace(/<\/?ol>/gi, '\n');                               // Ordered lists

    // Paragraphs and line breaks
    text = text.replace(/<\/p><p>/gi, '\n\n');                            // Paragraph breaks
    text = text.replace(/<p>/gi, '');                                     // Remove opening p tags
    text = text.replace(/<\/p>/gi, '\n');                                 // Closing p to newline
    text = text.replace(/<br\s*\/?>/gi, '\n');                            // Line breaks

    // Pre and code blocks
    text = text.replace(/<pre><code>(.*?)<\/code><\/pre>/gis, '```\n$1\n```'); // Code blocks
    text = text.replace(/<pre>(.*?)<\/pre>/gis, '```\n$1\n```');          // Pre blocks

    // Remove remaining HTML tags
    text = text.replace(/<[^>]+>/g, '');

    // Decode HTML entities
    text = text.replace(/&nbsp;/g, ' ');
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");

    // Clean up excessive whitespace and line breaks
    text = text.replace(/\n{3,}/g, '\n\n');                               // Max 2 consecutive newlines
    text = text.replace(/[ \t]+/g, ' ');                                  // Multiple spaces to single space
    text = text.replace(/\n /g, '\n');                                    // Remove spaces after newlines

    return text.trim();
};

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
                .setDescription(truncate(convertHtmlToMarkdown(newsItem.message), 500))
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
                        .setDescription(truncate(convertHtmlToMarkdown(subAlert.message), 500))
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
        // Only log error message without stack trace for cleaner logs
        console.error(`[handleAlerts] Error for statuspage ${statuspageId}: ${error.message}`);
    }
};
