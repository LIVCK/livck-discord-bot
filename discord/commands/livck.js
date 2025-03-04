import { domainFromUrl, normalizeUrl } from "../../util/String.js";
import { handleStatusPage } from "../../handlers/handleStatuspage.js";
import LIVCK from "../../api/livck.js";

export default (models) => ({
    data: {
        name: 'livck',
        description: 'Manage subscriptions to status pages',
        options: [
            {
                type: 1, // Subcommand
                name: 'subscribe',
                description: 'Subscribe to a status page',
                options: [
                    { type: 3, name: 'url', description: 'The status page URL', required: true }, // String
                    { type: 7, name: 'channel', description: 'The target channel', required: true }, // Channel
                    {
                        type: 3, // String
                        name: 'events',
                        description: 'Select event types to subscribe to',
                        required: true,
                        choices: [
                            { name: 'All', value: 'ALL' },
                            { name: 'Status', value: 'STATUS' },
                            { name: 'News', value: 'NEWS' },
                        ],
                    },
                ],
            },
            {
                type: 1, // Subcommand
                name: 'unsubscribe',
                description: 'Unsubscribe from a status page',
                options: [
                    { type: 3, name: 'url', description: 'The status page URL', required: false }, // String
                    { type: 7, name: 'channel', description: 'The target channel', required: false }, // Channel
                ],
            },
            {
                type: 1, // Subcommand
                name: 'list',
                description: 'List all subscriptions for this server',
                options: [],
            },
        ],
    },
    async execute(interaction, client) {
        const subcommand = interaction.options.getSubcommand();

        switch (subcommand) {
            case 'subscribe': {
                let url = interaction.options.getString('url');
                const channel = interaction.options.getChannel('channel');

                let eventTypes;
                switch (interaction.options.getString('events')) {
                    case 'STATUS':
                        eventTypes = { STATUS: true, NEWS: false };
                        break;
                    case 'NEWS':
                        eventTypes = { STATUS: false, NEWS: true };
                        break;
                    default:
                        eventTypes = { STATUS: true, NEWS: true };
                }

                try {
                    url = normalizeUrl(url, true);

                    let livck = new LIVCK(url);
                    if (!await livck.ensureIsLIVCK()) {
                        await interaction.reply({
                            content: 'The URL provided does not appear to be a valid LIVCK status page.',
                            ephemeral: true,
                        });
                        return;
                    }

                    let statuspage = await models.Statuspage.findOne({ where: { url } });
                    if (!statuspage) {
                        statuspage = await models.Statuspage.create({ url, name: domainFromUrl(url) });
                    }

                    const existingSubscription = await models.Subscription.findOne({
                        where: {
                            guildId: interaction.guildId,
                            channelId: channel.id,
                            statuspageId: statuspage.id,
                        },
                    });

                    if (existingSubscription) {
                        await interaction.reply({
                            content: `You are already subscribed to **${url}** in <#${channel.id}>.`,
                            ephemeral: true,
                        });
                        return;
                    }

                    await models.Subscription.create({
                        guildId: interaction.guildId,
                        channelId: channel.id,
                        statuspageId: statuspage.id,
                        eventTypes: eventTypes,
                        interval: 60,
                    });

                    await handleStatusPage(statuspage.id, client)

                    await interaction.reply({
                        content: `Successfully subscribed to **${url}** in <#${channel.id}>.`,
                        ephemeral: true,
                    });
                } catch (error) {
                    console.error('Error creating subscription:', error);
                    await interaction.reply({
                        content: 'An error occurred. Please try again later.',
                        ephemeral: true,
                    });
                }
                break;
            }

            case 'unsubscribe': {
                let url = interaction.options.getString('url');
                const channel = interaction.options.getChannel('channel');

                try {
                    url = normalizeUrl(url, true);

                    if (!url && !channel) {
                        await interaction.reply({
                            content: 'Please provide a URL or channel to unsubscribe from.',
                            ephemeral: true,
                        });
                        return;
                    }

                    if (url) {
                        const statuspage = await models.Statuspage.findOne({ where: { url } });
                        if (!statuspage) {
                            await interaction.reply({
                                content: `The status page **${url}** was not found.`,
                                ephemeral: true,
                            });
                            return;
                        }

                        const deletedCount = await models.Subscription.destroy({
                            where: {
                                guildId: interaction.guildId,
                                statuspageId: statuspage.id,
                                ...(channel ? { channelId: channel.id } : {}),
                            },
                        });

                        if (deletedCount === 0) {
                            await interaction.reply({
                                content: `No subscriptions found for **${url}**.`,
                                ephemeral: true,
                            });
                        } else {
                            await interaction.reply({
                                content: `Subscription for **${url}** successfully removed.`,
                                ephemeral: true,
                            });
                        }
                    } else if (channel) {
                        const deletedCount = await models.Subscription.destroy({
                            where: {
                                guildId: interaction.guildId,
                                channelId: channel.id,
                            },
                        });

                        if (deletedCount === 0) {
                            await interaction.reply({
                                content: `No subscriptions found in <#${channel.id}>.`,
                                ephemeral: true,
                            });
                        } else {
                            await interaction.reply({
                                content: `All subscriptions in <#${channel.id}> successfully removed.`,
                                ephemeral: true,
                            });
                        }
                    }
                } catch (error) {
                    console.error('Error removing subscription:', error);
                    await interaction.reply({
                        content: 'An error occurred. Please try again later.',
                        ephemeral: true,
                    });
                }
                break;
            }

            case 'list': {
                try {
                    const subscriptions = await models.Subscription.findAll({
                        where: { guildId: interaction.guildId },
                        include: [{ model: models.Statuspage }],
                    });

                    if (subscriptions.length === 0) {
                        await interaction.reply({
                            content: 'No subscriptions found for this server.',
                            ephemeral: true,
                        });
                        return;
                    }

                    const fields = subscriptions.map((sub) => ({
                        name: sub.Statuspage.name,
                        value: `**Statuspage:** [${sub.Statuspage.name}](${sub.Statuspage.url})\n**Events:** ${Object.keys(sub.eventTypes).filter(key => sub.eventTypes[key]).join(', ')}\n**Channel:** <#${sub.channelId}>\n\n`,
                    }));

                    await interaction.reply({
                        embeds: [
                            {
                                title: 'Your Subscriptions',
                                fields,
                                color: 0x00ff00,
                            },
                        ],
                        ephemeral: true,
                    });
                } catch (error) {
                    console.error('Error fetching subscriptions:', error);
                    await interaction.reply({
                        content: 'An error occurred. Please try again later.',
                        ephemeral: true,
                    });
                }
                break;
            }

            default:
                await interaction.reply({
                    content: 'Unknown subcommand. Use `/livck` to see available subcommands.',
                    ephemeral: true,
                });
        }
    },
});
