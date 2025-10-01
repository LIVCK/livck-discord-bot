import StatuspageService from "../services/statuspage.js";
import models from "../models/index.js";
import { generateEmbed } from "../messages/messageHelper.js";
import { getLayoutRenderer } from "../messages/layoutRenderers.js";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
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
            // Only log non-timeout errors with full stack trace
            if (fetchError.cause?.code === 'UND_ERR_CONNECT_TIMEOUT' || fetchError.message?.includes('timeout')) {
                console.warn(`[handleStatusPage] Timeout fetching ${statuspageRecord.url}`);
            } else {
                console.error('[handleStatusPage] Error in fetchAll:', fetchError.message);
            }
        }

        console.log('[handleStatusPage] Fetched categories:', statuspageService.categories?.length || 0);
        if (statuspageService.categories?.length === 0) {
            console.warn('[handleStatusPage] No categories fetched for', statuspageRecord.url);
        }

        await Promise.all(statuspageRecord.Subscriptions.map(async (subscription) => {
            try {
                if (!subscription.eventTypes.STATUS)
                    return;

                // Get the layout renderer for this subscription
                const layoutKey = subscription.layout || 'DETAILED';
                const renderer = getLayoutRenderer(layoutKey);

                // Render the layout - returns array of {embed, type} objects
                const renderResult = renderer(statuspageService, statuspageRecord, subscription.locale);
                console.log('[handleStatusPage] Rendered layout:', layoutKey, 'embeds:', renderResult.length);

                // Extract embeds from result
                const embeds = renderResult.map(r => r.embed);

                // Load custom links for this subscription
                const customLinks = await models.CustomLink.findAll({
                    where: { subscriptionId: subscription.id },
                    order: [['position', 'ASC']]
                });

                console.log(`[handleStatusPage] Found ${customLinks.length} custom links for subscription ${subscription.id}`);

                // Build button rows (max 5 buttons per row, max 5 rows)
                const components = [];
                if (customLinks.length > 0) {
                    const buttonRows = [];
                    let currentRow = [];

                    for (const link of customLinks.slice(0, 25)) { // Max 25 buttons total (5 rows x 5 buttons)
                        console.log(`[handleStatusPage] Adding button: ${link.label} (${link.url})`);

                        // URL buttons must use ButtonStyle.Link
                        const button = new ButtonBuilder()
                            .setLabel(link.label)
                            .setURL(link.url)
                            .setStyle(ButtonStyle.Link);

                        if (link.emoji) {
                            // Only set emoji if it's valid (custom emoji <:name:id> or Unicode, not Discord shortcode :name:)
                            // Discord shortcodes like :zap: are not valid for button emojis
                            if (link.emoji.startsWith('<') || !link.emoji.startsWith(':')) {
                                button.setEmoji(link.emoji);
                            }
                        }

                        currentRow.push(button);

                        // Create new row after 5 buttons
                        if (currentRow.length === 5) {
                            buttonRows.push(new ActionRowBuilder().addComponents(currentRow));
                            currentRow = [];
                        }
                    }

                    // Add remaining buttons
                    if (currentRow.length > 0) {
                        buttonRows.push(new ActionRowBuilder().addComponents(currentRow));
                    }

                    console.log(`[handleStatusPage] Created ${buttonRows.length} button rows with ${buttonRows.reduce((sum, row) => sum + row.components.length, 0)} total buttons`);

                    components.push(...buttonRows);
                }

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
                        console.log(`[handleStatusPage] Updating message ${existingMessage.messageId} with ${components.length} component rows`);
                        await message.edit({ embeds, components });
                        console.log(`[handleStatusPage] Successfully updated message`);
                    } catch (error) {
                        console.error(`[handleStatusPage] Error updating message:`, error.message);
                        if (error.code === 10008) {
                            await models.Message.destroy({
                                where: { subscriptionId: subscription.id, category: 'STATUS' },
                            });
                        }
                    }
                } else {
                    console.log(`[handleStatusPage] Creating new message with ${components.length} component rows`);
                    const message = await channel.send({ embeds, components });
                    console.log(`[handleStatusPage] Created message ${message.id}`);
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
        // Only log error message without stack trace for cleaner logs
        console.error(`[handleStatusPage] Error for statuspage ${statuspageId}: ${error.message}`);
    }
};
