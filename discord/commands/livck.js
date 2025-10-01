import { ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelSelectMenuBuilder as ChannelSelect } from "discord.js";
import { domainFromUrl, normalizeUrl } from "../../util/String.js";
import { handleStatusPage } from "../../handlers/handleStatuspage.js";
import LIVCK from "../../api/livck.js";
import translation from "../../util/Translation.js";

export default (models) => ({
    data: {
        name: 'livck',
        description: translation.trans('commands.livck.description', {}, null, 'en'),
        description_localizations: translation.localizeExcept('commands.livck.description'),
        default_member_permissions: '32', // ManageGuild permission
        dm_permission: false, // Server-only command
        options: [
            {
                type: 1, // Subcommand
                name: 'subscribe',
                description: translation.trans('commands.livck.subcommands.subscribe.description', {}, null, 'en'),
                description_localizations: translation.localizeExcept('commands.livck.subcommands.subscribe.description'),
                options: [],
            },
            {
                type: 1,
                name: 'unsubscribe',
                description: translation.trans('commands.livck.subcommands.unsubscribe.description', {}, null, 'en'),
                description_localizations: translation.localizeExcept('commands.livck.subcommands.unsubscribe.description'),
                options: [
                    {
                        type: 3,
                        name: 'url',
                        description: translation.trans('commands.livck.options.url.description', {}, null, 'en'),
                        description_localizations: translation.localizeExcept('commands.livck.options.url.description'),
                        required: false
                    },
                    {
                        type: 7,
                        name: 'channel',
                        description: translation.trans('commands.livck.options.channel.description', {}, null, 'en'),
                        description_localizations: translation.localizeExcept('commands.livck.options.channel.description'),
                        required: false
                    },
                ],
            },
            {
                type: 1,
                name: 'list',
                description: translation.trans('commands.livck.subcommands.list.description', {}, null, 'en'),
                description_localizations: translation.localizeExcept('commands.livck.subcommands.list.description'),
                options: [],
            },
            {
                type: 1,
                name: 'edit',
                description: translation.trans('commands.livck.subcommands.edit.description', {}, null, 'en'),
                description_localizations: translation.localizeExcept('commands.livck.subcommands.edit.description'),
                options: [
                    {
                        type: 3,
                        name: 'subscription',
                        description: translation.trans('commands.livck.options.subscription.description', {}, null, 'en'),
                        description_localizations: translation.localizeExcept('commands.livck.options.subscription.description'),
                        required: true,
                        autocomplete: true
                    }
                ],
            },
            {
                type: 1,
                name: 'resume',
                description: translation.trans('commands.livck.subcommands.resume.description', {}, null, 'en'),
                description_localizations: translation.localizeExcept('commands.livck.subcommands.resume.description'),
                options: [
                    {
                        type: 3,
                        name: 'url',
                        description: translation.trans('commands.livck.options.url.description', {}, null, 'en'),
                        description_localizations: translation.localizeExcept('commands.livck.options.url.description'),
                        required: true
                    }
                ],
            },
        ],
    },
    async execute(interaction, client) {
        const subcommand = interaction.options.getSubcommand();

        // Check permissions for write operations
        if (['subscribe', 'unsubscribe', 'edit', 'resume'].includes(subcommand)) {
            if (!interaction.member.permissions.has('ManageGuild')) {
                const userLocale = interaction.locale?.split('-')[0] || 'de';
                translation.setLocale(['de', 'en'].includes(userLocale) ? userLocale : 'de');

                await interaction.reply({
                    content: translation.trans('errors.missing_permissions'),
                    ephemeral: true
                });
                return;
            }
        }

        switch (subcommand) {
            case 'subscribe': {
                try {
                    const userLocale = interaction.locale?.split('-')[0] || 'de';
                    translation.setLocale(['de', 'en'].includes(userLocale) ? userLocale : 'de');

                    // Create modal with raw API payload to include select menus using Type 18 Label components
                    const modalPayload = {
                        type: 9, // MODAL response type
                        data: {
                            custom_id: 'subscribe_complete_modal',
                            title: translation.trans('commands.livck.subscribe.modal_title'),
                            components: [
                                // URL Text Input with Label
                                {
                                    type: 18, // Label component
                                    label: translation.trans('commands.livck.subscribe.modal_url_label'),
                                    component: {
                                        type: 4, // Text Input
                                        custom_id: 'url',
                                        style: 1, // Short
                                        placeholder: 'https://status.example.com',
                                        required: true
                                    }
                                },
                                // Channel Select with Label
                                {
                                    type: 18, // Label component
                                    label: translation.trans('commands.livck.subscribe.select_channel'),
                                    component: {
                                        type: 8, // Channel Select
                                        custom_id: 'channel',
                                        placeholder: translation.trans('commands.livck.subscribe.select_channel'),
                                        channel_types: [0, 5], // GuildText (0), GuildAnnouncement (5)
                                        required: true
                                    }
                                },
                                // Events String Select with Label
                                {
                                    type: 18, // Label component
                                    label: translation.trans('commands.livck.subscribe.select_events'),
                                    component: {
                                        type: 3, // String Select
                                        custom_id: 'events',
                                        placeholder: translation.trans('commands.livck.subscribe.select_events'),
                                        required: true,
                                        options: [
                                            {
                                                label: translation.trans('commands.livck.choices.all'),
                                                value: 'all',
                                                default: true
                                            },
                                            {
                                                label: translation.trans('commands.livck.choices.status'),
                                                value: 'status'
                                            },
                                            {
                                                label: translation.trans('commands.livck.choices.news'),
                                                value: 'news'
                                            }
                                        ]
                                    }
                                },
                                // Locale String Select with Label
                                {
                                    type: 18, // Label component
                                    label: translation.trans('commands.livck.subscribe.select_locale'),
                                    component: {
                                        type: 3, // String Select
                                        custom_id: 'locale',
                                        placeholder: translation.trans('commands.livck.subscribe.select_locale'),
                                        required: true,
                                        options: [
                                            {
                                                label: '🇩🇪 Deutsch',
                                                value: 'de',
                                                default: userLocale === 'de'
                                            },
                                            {
                                                label: '🇬🇧 English',
                                                value: 'en',
                                                default: userLocale === 'en'
                                            }
                                        ]
                                    }
                                },
                                // Layout String Select with Label
                                {
                                    type: 18, // Label component
                                    label: translation.trans('commands.livck.subscribe.select_layout'),
                                    component: {
                                        type: 3, // String Select
                                        custom_id: 'layout',
                                        placeholder: translation.trans('commands.livck.subscribe.select_layout'),
                                        required: true,
                                        options: [
                                            {
                                                label: translation.trans('commands.livck.layouts.detailed.name'),
                                                description: translation.trans('commands.livck.layouts.detailed.description'),
                                                value: 'DETAILED',
                                                default: true
                                            },
                                            {
                                                label: translation.trans('commands.livck.layouts.compact.name'),
                                                description: translation.trans('commands.livck.layouts.compact.description'),
                                                value: 'COMPACT'
                                            },
                                            {
                                                label: translation.trans('commands.livck.layouts.overview.name'),
                                                description: translation.trans('commands.livck.layouts.overview.description'),
                                                value: 'OVERVIEW'
                                            },
                                            // {
                                            //     label: translation.trans('commands.livck.layouts.tree.name'),
                                            //     description: translation.trans('commands.livck.layouts.tree.description'),
                                            //     value: 'TREE'
                                            // },
                                            {
                                                label: translation.trans('commands.livck.layouts.minimal.name'),
                                                description: translation.trans('commands.livck.layouts.minimal.description'),
                                                value: 'MINIMAL'
                                            }
                                        ]
                                    }
                                }
                            ]
                        }
                    };

                    // Send raw API response
                    await interaction.client.rest.post(
                        `/interactions/${interaction.id}/${interaction.token}/callback`,
                        { body: modalPayload }
                    );
                } catch (error) {
                    console.error('Error showing subscribe modal:', error);
                    if (!interaction.replied) {
                        await interaction.reply({
                            content: translation.trans('commands.livck.subscribe.error'),
                            flags: 64 // EPHEMERAL flag
                        });
                    }
                }
                break;
            }

            case 'unsubscribe': {
                let url = interaction.options.getString('url');
                const channel = interaction.options.getChannel('channel');

                try {
                    const userLocale = interaction.locale?.split('-')[0] || 'de';
                    translation.setLocale(['de', 'en'].includes(userLocale) ? userLocale : 'de');

                    url = normalizeUrl(url, true);

                    if (!url && !channel) {
                        await interaction.reply({
                            content: translation.trans('commands.livck.unsubscribe.missing_params'),
                            ephemeral: true,
                        });
                        return;
                    }

                    if (url) {
                        const statuspage = await models.Statuspage.findOne({ where: { url } });
                        if (!statuspage) {
                            await interaction.reply({
                                content: translation.trans('commands.livck.subscribe.statuspage_not_found', { url }),
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
                                content: translation.trans('commands.livck.unsubscribe.no_subscriptions', { url }, 0),
                                ephemeral: true,
                            });
                        } else {
                            await interaction.reply({
                                content: translation.trans('commands.livck.unsubscribe.success', { url }),
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
                                content: translation.trans('commands.livck.unsubscribe.no_subscriptions', { channelId: channel.id }, 1),
                                ephemeral: true,
                            });
                        } else {
                            await interaction.reply({
                                content: translation.trans('commands.livck.unsubscribe.success_channel', { channelId: channel.id }),
                                ephemeral: true,
                            });
                        }
                    }
                } catch (error) {
                    console.error('Error removing subscription:', error);
                    await interaction.reply({
                        content: translation.trans('commands.livck.unsubscribe.error'),
                        ephemeral: true,
                    });
                }
                break;
            }

            case 'list': {
                try {
                    const userLocale = interaction.locale?.split('-')[0] || 'de';
                    translation.setLocale(['de', 'en'].includes(userLocale) ? userLocale : 'de');

                    const subscriptions = await models.Subscription.findAll({
                        where: { guildId: interaction.guildId },
                        include: [{ model: models.Statuspage }],
                    });

                    if (subscriptions.length === 0) {
                        await interaction.reply({
                            content: translation.trans('commands.livck.list.no_subscriptions'),
                            ephemeral: true,
                        });
                        return;
                    }

                    // Helper to get event emojis
                    const getEventEmoji = (eventTypes) => {
                        const hasStatus = eventTypes.STATUS;
                        const hasNews = eventTypes.NEWS;
                        if (hasStatus && hasNews) return '⚡';
                        if (hasStatus) return '📊';
                        if (hasNews) return '📰';
                        return '❓';
                    };

                    const getEventText = (eventTypes) => {
                        const active = Object.keys(eventTypes).filter(key => eventTypes[key]);
                        if (active.length === Object.keys(eventTypes).length) {
                            return translation.trans('commands.livck.choices.all');
                        }
                        return active.map(e => translation.trans(`commands.livck.choices.${e.toLowerCase()}`)).join(', ');
                    };

                    // Create individual embed cards (max 10, no buttons)
                    const embeds = subscriptions.slice(0, 10).map((sub, index) => {
                        const langFlag = sub.locale === 'de' ? '🇩🇪' : '🇬🇧';
                        const eventText = getEventText(sub.eventTypes);
                        const hostname = new URL(sub.Statuspage.url).hostname;

                        // Use full URL directly (Google's older endpoint works better with Discord)
                        const faviconUrl = `https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${encodeURIComponent(sub.Statuspage.url)}&size=64`;

                        return {
                            author: {
                                name: sub.Statuspage.name,
                                url: sub.Statuspage.url,
                                icon_url: faviconUrl
                            },
                            fields: [
                                {
                                    name: translation.trans('commands.livck.list.channel_label'),
                                    value: `<#${sub.channelId}>`,
                                    inline: true
                                },
                                {
                                    name: translation.trans('commands.livck.list.events_label'),
                                    value: eventText,
                                    inline: true
                                },
                                {
                                    name: translation.trans('commands.livck.list.language_label'),
                                    value: `${langFlag} ${sub.locale.toUpperCase()}`,
                                    inline: true
                                }
                            ],
                            color: 0x5865F2,
                            url: sub.Statuspage.url,
                            footer: {
                                text: hostname
                            }
                        };
                    });

                    await interaction.reply({
                        embeds,
                        ephemeral: true,
                    });
                } catch (error) {
                    console.error('Error fetching subscriptions:', error);
                    await interaction.reply({
                        content: translation.trans('commands.livck.list.error'),
                        ephemeral: true,
                    });
                }
                break;
            }

            case 'edit': {
                try {
                    const userLocale = interaction.locale?.split('-')[0] || 'de';
                    translation.setLocale(['de', 'en'].includes(userLocale) ? userLocale : 'de');

                    const subscriptionId = interaction.options.getString('subscription');

                    const subscription = await models.Subscription.findOne({
                        where: {
                            id: subscriptionId,
                            guildId: interaction.guildId
                        },
                        include: [{ model: models.Statuspage }]
                    });

                    if (!subscription) {
                        await interaction.reply({
                            content: translation.trans('commands.livck.list.subscription_not_found'),
                            ephemeral: true
                        });
                        return;
                    }

                    // Show edit options with select menus
                    const localeSelectMenu = new StringSelectMenuBuilder()
                        .setCustomId(`update_locale_${subscription.id}`)
                        .setPlaceholder(translation.trans('commands.livck.list.edit_select_locale'))
                        .addOptions(
                            new StringSelectMenuOptionBuilder()
                                .setLabel('🇩🇪 Deutsch')
                                .setValue('de')
                                .setDefault(subscription.locale === 'de'),
                            new StringSelectMenuOptionBuilder()
                                .setLabel('🇬🇧 English')
                                .setValue('en')
                                .setDefault(subscription.locale === 'en')
                        );

                    const layoutSelectMenu = new StringSelectMenuBuilder()
                        .setCustomId(`update_layout_${subscription.id}`)
                        .setPlaceholder(translation.trans('commands.livck.subscribe.select_layout'))
                        .addOptions(
                            new StringSelectMenuOptionBuilder()
                                .setLabel(translation.trans('commands.livck.layouts.detailed.name'))
                                .setDescription(translation.trans('commands.livck.layouts.detailed.description'))
                                .setValue('DETAILED')
                                .setDefault(subscription.layout === 'DETAILED'),
                            new StringSelectMenuOptionBuilder()
                                .setLabel(translation.trans('commands.livck.layouts.compact.name'))
                                .setDescription(translation.trans('commands.livck.layouts.compact.description'))
                                .setValue('COMPACT')
                                .setDefault(subscription.layout === 'COMPACT'),
                            new StringSelectMenuOptionBuilder()
                                .setLabel(translation.trans('commands.livck.layouts.overview.name'))
                                .setDescription(translation.trans('commands.livck.layouts.overview.description'))
                                .setValue('OVERVIEW')
                                .setDefault(subscription.layout === 'OVERVIEW'),
                            // new StringSelectMenuOptionBuilder()
                            //     .setLabel(translation.trans('commands.livck.layouts.tree.name'))
                            //     .setDescription(translation.trans('commands.livck.layouts.tree.description'))
                            //     .setValue('TREE')
                            //     .setDefault(subscription.layout === 'TREE'),
                            new StringSelectMenuOptionBuilder()
                                .setLabel(translation.trans('commands.livck.layouts.minimal.name'))
                                .setDescription(translation.trans('commands.livck.layouts.minimal.description'))
                                .setValue('MINIMAL')
                                .setDefault(subscription.layout === 'MINIMAL')
                        );

                    const localeRow = new ActionRowBuilder().addComponents(localeSelectMenu);
                    const layoutRow = new ActionRowBuilder().addComponents(layoutSelectMenu);

                    // Action buttons
                    const manageLinksButton = new ButtonBuilder()
                        .setCustomId(`manage_links_${subscription.id}`)
                        .setLabel(translation.trans('commands.livck.edit.manage_links_button'))
                        .setStyle(ButtonStyle.Primary)

                    const deleteButton = new ButtonBuilder()
                        .setCustomId(`delete_sub_${subscription.id}`)
                        .setLabel(translation.trans('commands.livck.list.delete_button'))
                        .setStyle(ButtonStyle.Danger)

                    const doneButton = new ButtonBuilder()
                        .setCustomId('edit_done')
                        .setLabel(translation.trans('commands.livck.edit.done_button'))
                        .setStyle(ButtonStyle.Success)

                    const buttonRow = new ActionRowBuilder().addComponents(manageLinksButton, deleteButton, doneButton);

                    await interaction.reply({
                        content: translation.trans('commands.livck.edit.editing', {
                            name: subscription.Statuspage.name || subscription.Statuspage.url,
                            channelId: subscription.channelId
                        }),
                        components: [localeRow, layoutRow, buttonRow],
                        ephemeral: true
                    });
                } catch (error) {
                    console.error('Error showing edit menu:', error);
                    await interaction.reply({
                        content: translation.trans('commands.livck.edit.error'),
                        ephemeral: true,
                    });
                }
                break;
            }

            case 'resume': {
                try {
                    const userLocale = interaction.locale?.split('-')[0] || 'de';
                    translation.setLocale(['de', 'en'].includes(userLocale) ? userLocale : 'de');

                    const url = normalizeUrl(interaction.options.getString('url'), true);

                    // Find statuspage with subscriptions for this guild
                    const statuspage = await models.Statuspage.findOne({
                        where: { url },
                        include: [{
                            model: models.Subscription,
                            where: { guildId: interaction.guildId },
                            required: true
                        }]
                    });

                    if (!statuspage) {
                        await interaction.reply({
                            content: translation.trans('commands.livck.resume.not_found', { url }),
                            flags: 64
                        });
                        return;
                    }

                    if (!statuspage.paused) {
                        await interaction.reply({
                            content: translation.trans('commands.livck.resume.not_paused', { url }),
                            flags: 64
                        });
                        return;
                    }

                    // Import pause manager
                    const { default: StatuspagePauseManager } = await import('../../services/statuspagePauseManager.js');

                    const result = await StatuspagePauseManager.resume(statuspage, true);

                    if (result.success) {
                        await interaction.reply({
                            content: translation.trans('commands.livck.resume.success', {
                                url,
                                reason: translation.trans(`commands.livck.resume.reasons.${statuspage.pauseReason || 'unknown'}`)
                            }),
                            flags: 64
                        });
                    } else {
                        await interaction.reply({
                            content: translation.trans('commands.livck.resume.failed', {
                                url,
                                message: result.message
                            }),
                            flags: 64
                        });
                    }
                } catch (error) {
                    console.error('Error resuming statuspage:', error);
                    await interaction.reply({
                        content: translation.trans('commands.livck.resume.error'),
                        flags: 64
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

    // Handle component interactions (select menus, buttons)
    async handleComponentInteraction(interaction, client) {
        const userLocale = interaction.locale?.split('-')[0] || 'de';
        translation.setLocale(['de', 'en'].includes(userLocale) ? userLocale : 'de');

        // Handle subscription select menu
        if (interaction.customId === 'subscription_select') {
            const subscriptionId = interaction.values[0].replace('sub_', '');
            const subscription = await models.Subscription.findOne({
                where: { id: subscriptionId },
                include: [{ model: models.Statuspage }]
            });

            if (!subscription) {
                await interaction.reply({
                    content: translation.trans('commands.livck.list.subscription_not_found'),
                    ephemeral: true
                });
                return;
            }

            const langFlag = subscription.locale === 'de' ? '🇩🇪' : '🇬🇧';
            const events = Object.keys(subscription.eventTypes)
                .filter(key => subscription.eventTypes[key])
                .map(e => translation.trans(`commands.livck.choices.${e.toLowerCase()}`))
                .join(', ');

            // Create detail embed
            const detailEmbed = {
                title: subscription.Statuspage.name,
                url: subscription.Statuspage.url,
                color: 0x5865F2,
                thumbnail: {
                    url: `https://www.google.com/s2/favicons?domain=${new URL(subscription.Statuspage.url).hostname}&sz=128`
                },
                fields: [
                    {
                        name: translation.trans('commands.livck.list.channel_label'),
                        value: `<#${subscription.channelId}>`,
                        inline: true
                    },
                    {
                        name: translation.trans('commands.livck.list.language_label'),
                        value: `${langFlag} ${subscription.locale.toUpperCase()}`,
                        inline: true
                    },
                    {
                        name: translation.trans('commands.livck.list.events_label'),
                        value: events,
                        inline: true
                    }
                ],
                footer: {
                    text: `ID: ${subscription.id}`
                }
            };

            // Create action buttons
            const openButton = new ButtonBuilder()
                .setLabel(translation.trans('commands.livck.list.open_button'))
                .setStyle(ButtonStyle.Link)
                .setURL(subscription.Statuspage.url)

            const unsubButton = new ButtonBuilder()
                .setCustomId(`unsub_${subscription.id}`)
                .setLabel(translation.trans('commands.livck.list.unsubscribe_button'))
                .setStyle(ButtonStyle.Danger)

            const row = new ActionRowBuilder().addComponents(openButton, unsubButton);

            await interaction.reply({
                embeds: [detailEmbed],
                components: [row],
                ephemeral: true
            });
        }

        // Handle refresh button
        if (interaction.customId === 'refresh_list') {
            await interaction.deferUpdate();
            // Trigger list command logic again
            // ... (re-fetch subscriptions and update message)
            await interaction.editReply({
                content: translation.trans('commands.livck.list.refreshed'),
                components: interaction.message.components
            });
        }

        // Handle delete button from list
        if (interaction.customId.startsWith('delete_sub_')) {
            await interaction.deferUpdate();

            const subscriptionId = interaction.customId.replace('delete_sub_', '');

            const subscription = await models.Subscription.findOne({
                where: { id: subscriptionId },
                include: [{ model: models.Statuspage }]
            });

            if (!subscription) {
                await interaction.editReply({
                    content: translation.trans('commands.livck.list.subscription_not_found'),
                    embeds: [],
                    components: []
                });
                return;
            }

            await models.Subscription.destroy({ where: { id: subscriptionId } });

            await interaction.editReply({
                content: translation.trans('commands.livck.unsubscribe.success', { url: subscription.Statuspage.url }),
                embeds: [],
                components: []
            });
        }


        // Handle edit button from list (old handler - can be removed)
        if (interaction.customId.startsWith('edit_sub_')) {
            const subscriptionId = interaction.customId.replace('edit_sub_', '');

            const subscription = await models.Subscription.findOne({
                where: { id: subscriptionId },
                include: [{ model: models.Statuspage }]
            });

            if (!subscription) {
                await interaction.reply({
                    content: translation.trans('commands.livck.list.subscription_not_found'),
                    ephemeral: true
                });
                return;
            }

            // Show current settings with select menus to edit
            const eventSelectMenu = new StringSelectMenuBuilder()
                .setCustomId(`edit_events_${subscription.id}`)
                .setPlaceholder(translation.trans('commands.livck.list.edit_select_events'))
                .addOptions(
                    new StringSelectMenuOptionBuilder()
                        .setLabel(translation.trans('commands.livck.choices.all'))
                        .setValue('ALL')
                        .setDefault(subscription.eventTypes.STATUS && subscription.eventTypes.NEWS),
                    new StringSelectMenuOptionBuilder()
                        .setLabel(translation.trans('commands.livck.choices.status'))
                        .setValue('STATUS')
                        .setDefault(subscription.eventTypes.STATUS && !subscription.eventTypes.NEWS),
                    new StringSelectMenuOptionBuilder()
                        .setLabel(translation.trans('commands.livck.choices.news'))
                        .setValue('NEWS')
                        .setDefault(!subscription.eventTypes.STATUS && subscription.eventTypes.NEWS)
                );

            const localeSelectMenu = new StringSelectMenuBuilder()
                .setCustomId(`edit_locale_${subscription.id}`)
                .setPlaceholder(translation.trans('commands.livck.list.edit_select_locale'))
                .addOptions(
                    new StringSelectMenuOptionBuilder()
                        .setLabel('🇩🇪 Deutsch')
                        .setValue('de')
                        .setDefault(subscription.locale === 'de'),
                    new StringSelectMenuOptionBuilder()
                        .setLabel('🇬🇧 English')
                        .setValue('en')
                        .setDefault(subscription.locale === 'en')
                );

            const eventRow = new ActionRowBuilder().addComponents(eventSelectMenu);
            const localeRow = new ActionRowBuilder().addComponents(localeSelectMenu);

            await interaction.reply({
                content: translation.trans('commands.livck.list.edit_prompt', {
                    name: subscription.Statuspage.name,
                    channelId: subscription.channelId
                }),
                components: [eventRow, localeRow],
                ephemeral: true
            });
        }


        // Handle locale update
        if (interaction.customId.startsWith('update_locale_')) {
            const subscriptionId = interaction.customId.replace('update_locale_', '');
            const newLocale = interaction.values[0];

            // Defer update immediately to prevent timeout
            await interaction.deferUpdate();

            await models.Subscription.update(
                { locale: newLocale },
                { where: { id: subscriptionId } }
            );

            // Reload the edit interface with updated values
            const subscription = await models.Subscription.findOne({
                where: { id: subscriptionId },
                include: [{ model: models.Statuspage }]
            });

            // Trigger status page refresh with new locale (fire-and-forget)
            if (subscription && subscription.Statuspage) {
                handleStatusPage(subscription.Statuspage.id, client).catch(error => {
                    console.error('[Locale Update] Failed to regenerate status message:', error);
                });
            }

            const localeSelectMenu = new StringSelectMenuBuilder()
                .setCustomId(`update_locale_${subscription.id}`)
                .setPlaceholder(translation.trans('commands.livck.list.edit_select_locale'))
                .addOptions(
                    new StringSelectMenuOptionBuilder()
                        .setLabel('🇩🇪 Deutsch')
                        .setValue('de')
                        .setDefault(subscription.locale === 'de'),
                    new StringSelectMenuOptionBuilder()
                        .setLabel('🇬🇧 English')
                        .setValue('en')
                        .setDefault(subscription.locale === 'en')
                );

            const localeRow = new ActionRowBuilder().addComponents(localeSelectMenu);

            const layoutSelectMenu = new StringSelectMenuBuilder()
                .setCustomId(`update_layout_${subscription.id}`)
                .setPlaceholder(translation.trans('commands.livck.subscribe.select_layout'))
                .addOptions(
                    new StringSelectMenuOptionBuilder()
                        .setLabel(translation.trans('commands.livck.layouts.detailed.name'))
                        .setDescription(translation.trans('commands.livck.layouts.detailed.description'))
                        .setValue('DETAILED')
                        .setDefault(subscription.layout === 'DETAILED'),
                    new StringSelectMenuOptionBuilder()
                        .setLabel(translation.trans('commands.livck.layouts.compact.name'))
                        .setDescription(translation.trans('commands.livck.layouts.compact.description'))
                        .setValue('COMPACT')
                        .setDefault(subscription.layout === 'COMPACT'),
                    new StringSelectMenuOptionBuilder()
                        .setLabel(translation.trans('commands.livck.layouts.overview.name'))
                        .setDescription(translation.trans('commands.livck.layouts.overview.description'))
                        .setValue('OVERVIEW')
                        .setDefault(subscription.layout === 'OVERVIEW'),
                    // new StringSelectMenuOptionBuilder()
                    //     .setLabel(translation.trans('commands.livck.layouts.tree.name'))
                    //     .setDescription(translation.trans('commands.livck.layouts.tree.description'))
                    //     .setValue('TREE')
                    //     .setDefault(subscription.layout === 'TREE'),
                    new StringSelectMenuOptionBuilder()
                        .setLabel(translation.trans('commands.livck.layouts.minimal.name'))
                        .setDescription(translation.trans('commands.livck.layouts.minimal.description'))
                        .setValue('MINIMAL')
                        .setDefault(subscription.layout === 'MINIMAL')
                );

            const layoutRow = new ActionRowBuilder().addComponents(layoutSelectMenu);

            const manageLinksButton = new ButtonBuilder()
                .setCustomId(`manage_links_${subscription.id}`)
                .setLabel(translation.trans('commands.livck.edit.manage_links_button'))
                .setStyle(ButtonStyle.Primary)

            const deleteButton = new ButtonBuilder()
                .setCustomId(`delete_sub_${subscription.id}`)
                .setLabel(translation.trans('commands.livck.list.delete_button'))
                .setStyle(ButtonStyle.Danger)

            const doneButton = new ButtonBuilder()
                .setCustomId('edit_done')
                .setLabel(translation.trans('commands.livck.edit.done_button'))
                .setStyle(ButtonStyle.Success)

            const buttonRow = new ActionRowBuilder().addComponents(manageLinksButton, deleteButton, doneButton);

            await interaction.editReply({
                content: translation.trans('commands.livck.edit.updated', {
                    field: translation.trans('commands.livck.list.language_label'),
                    name: subscription.Statuspage.name || subscription.Statuspage.url,
                    channelId: subscription.channelId
                }),
                components: [localeRow, layoutRow, buttonRow]
            });
        }

        // Handle layout update
        if (interaction.customId.startsWith('update_layout_')) {
            const subscriptionId = interaction.customId.replace('update_layout_', '');
            const newLayout = interaction.values[0];

            // Defer update immediately to prevent timeout
            await interaction.deferUpdate();

            await models.Subscription.update(
                { layout: newLayout },
                { where: { id: subscriptionId } }
            );

            // Reload the edit interface with updated values
            const subscription = await models.Subscription.findOne({
                where: { id: subscriptionId },
                include: [{ model: models.Statuspage }]
            });

            // Trigger immediate status page refresh with new layout (fire-and-forget)
            if (subscription && subscription.Statuspage) {
                handleStatusPage(subscription.Statuspage.id, client).then(() => {
                    console.log(`[Layout Update] Regenerated status message for subscription ${subscriptionId} with layout ${newLayout}`);
                }).catch(error => {
                    console.error(`[Layout Update] Failed to regenerate status message:`, error);
                });
            }

            const localeSelectMenu = new StringSelectMenuBuilder()
                .setCustomId(`update_locale_${subscription.id}`)
                .setPlaceholder(translation.trans('commands.livck.list.edit_select_locale'))
                .addOptions(
                    new StringSelectMenuOptionBuilder()
                        .setLabel('🇩🇪 Deutsch')
                        .setValue('de')
                        .setDefault(subscription.locale === 'de'),
                    new StringSelectMenuOptionBuilder()
                        .setLabel('🇬🇧 English')
                        .setValue('en')
                        .setDefault(subscription.locale === 'en')
                );

            const layoutSelectMenu = new StringSelectMenuBuilder()
                .setCustomId(`update_layout_${subscription.id}`)
                .setPlaceholder(translation.trans('commands.livck.subscribe.select_layout'))
                .addOptions(
                    new StringSelectMenuOptionBuilder()
                        .setLabel(translation.trans('commands.livck.layouts.detailed.name'))
                        .setDescription(translation.trans('commands.livck.layouts.detailed.description'))
                        .setValue('DETAILED')
                        .setDefault(subscription.layout === 'DETAILED'),
                    new StringSelectMenuOptionBuilder()
                        .setLabel(translation.trans('commands.livck.layouts.compact.name'))
                        .setDescription(translation.trans('commands.livck.layouts.compact.description'))
                        .setValue('COMPACT')
                        .setDefault(subscription.layout === 'COMPACT'),
                    new StringSelectMenuOptionBuilder()
                        .setLabel(translation.trans('commands.livck.layouts.overview.name'))
                        .setDescription(translation.trans('commands.livck.layouts.overview.description'))
                        .setValue('OVERVIEW')
                        .setDefault(subscription.layout === 'OVERVIEW'),
                    // new StringSelectMenuOptionBuilder()
                    //     .setLabel(translation.trans('commands.livck.layouts.tree.name'))
                    //     .setDescription(translation.trans('commands.livck.layouts.tree.description'))
                    //     .setValue('TREE')
                    //     .setDefault(subscription.layout === 'TREE'),
                    new StringSelectMenuOptionBuilder()
                        .setLabel(translation.trans('commands.livck.layouts.minimal.name'))
                        .setDescription(translation.trans('commands.livck.layouts.minimal.description'))
                        .setValue('MINIMAL')
                        .setDefault(subscription.layout === 'MINIMAL')
                );

            const localeRow = new ActionRowBuilder().addComponents(localeSelectMenu);
            const layoutRow = new ActionRowBuilder().addComponents(layoutSelectMenu);

            const manageLinksButton = new ButtonBuilder()
                .setCustomId(`manage_links_${subscription.id}`)
                .setLabel(translation.trans('commands.livck.edit.manage_links_button'))
                .setStyle(ButtonStyle.Primary)

            const deleteButton = new ButtonBuilder()
                .setCustomId(`delete_sub_${subscription.id}`)
                .setLabel(translation.trans('commands.livck.list.delete_button'))
                .setStyle(ButtonStyle.Danger)

            const doneButton = new ButtonBuilder()
                .setCustomId('edit_done')
                .setLabel(translation.trans('commands.livck.edit.done_button'))
                .setStyle(ButtonStyle.Success)

            const buttonRow = new ActionRowBuilder().addComponents(manageLinksButton, deleteButton, doneButton);

            await interaction.editReply({
                content: translation.trans('commands.livck.edit.updated', {
                    field: translation.trans('commands.livck.list.layout_label'),
                    name: subscription.Statuspage.name || subscription.Statuspage.url,
                    channelId: subscription.channelId
                }),
                components: [localeRow, layoutRow, buttonRow]
            });
        }

        // Handle "Manage Links" button
        if (interaction.customId.startsWith('manage_links_')) {
            const subscriptionId = interaction.customId.replace('manage_links_', '');

            // Defer update immediately to prevent timeout
            await interaction.deferUpdate();

            const subscription = await models.Subscription.findOne({
                where: { id: subscriptionId },
                include: [{ model: models.Statuspage }]
            });

            if (!subscription) {
                await interaction.followUp({
                    content: translation.trans('commands.livck.list.subscription_not_found'),
                    ephemeral: true
                });
                return;
            }

            // Load existing links
            const customLinks = await models.CustomLink.findAll({
                where: { subscriptionId },
                order: [['position', 'ASC']]
            });

            // Build link list message with emoji preview
            let linksList = customLinks.length > 0
                ? customLinks.map((link, index) => {
                    const emoji = link.emoji || '🔗';
                    return `${index + 1}. ${emoji} **${link.label}** - \`${link.url}\``;
                  }).join('\n')
                : translation.trans('commands.livck.custom_links.no_links');

            // Build buttons
            const addButton = new ButtonBuilder()
                .setCustomId(`add_link_${subscriptionId}`)
                .setLabel(translation.trans('commands.livck.custom_links.add_button'))
                .setStyle(ButtonStyle.Success)
                .setDisabled(customLinks.length >= 25);

            const backButton = new ButtonBuilder()
                .setCustomId(`back_to_edit_${subscriptionId}`)
                .setLabel(translation.trans('commands.livck.custom_links.back_button'))
                .setStyle(ButtonStyle.Secondary);

            const buttonRow = new ActionRowBuilder().addComponents(addButton, backButton);
            const components = [buttonRow];

            // Add select menu for link management (edit/delete)
            if (customLinks.length > 0) {
                const linkSelectMenu = new StringSelectMenuBuilder()
                    .setCustomId(`select_link_${subscriptionId}`)
                    .setPlaceholder(translation.trans('commands.livck.custom_links.select_placeholder'))
                    .addOptions(
                        customLinks.slice(0, 25).map((link, index) => {
                            return new StringSelectMenuOptionBuilder()
                                .setLabel(`${index + 1}. ${link.label}`)
                                .setValue(`link_${link.id}`)
                                .setDescription(link.url.substring(0, 100));
                        })
                    );

                const selectRow = new ActionRowBuilder().addComponents(linkSelectMenu);
                components.push(selectRow);
            }

            await interaction.editReply({
                content: translation.trans('commands.livck.custom_links.title', {
                    name: subscription.Statuspage.name || subscription.Statuspage.url
                }) + '\n\n' + linksList,
                components
            });
        }

        // Handle "Back to Edit" button
        if (interaction.customId.startsWith('back_to_edit_')) {
            const subscriptionId = interaction.customId.replace('back_to_edit_', '');

            // Reload edit menu - basically same as /livck edit
            const subscription = await models.Subscription.findOne({
                where: { id: subscriptionId },
                include: [{ model: models.Statuspage }]
            });

            if (!subscription) {
                await interaction.reply({
                    content: translation.trans('commands.livck.list.subscription_not_found'),
                    ephemeral: true
                });
                return;
            }

            // Defer update immediately
            await interaction.deferUpdate();

            // Build edit menu components
            const eventSelectMenu = new StringSelectMenuBuilder()
                .setCustomId(`update_events_${subscription.id}`)
                .setPlaceholder(translation.trans('commands.livck.list.edit_select_events'))
                .addOptions(
                    new StringSelectMenuOptionBuilder()
                        .setLabel(translation.trans('commands.livck.choices.all'))
                        .setValue('ALL')
                        .setDefault(subscription.eventTypes.STATUS && subscription.eventTypes.NEWS),
                    new StringSelectMenuOptionBuilder()
                        .setLabel(translation.trans('commands.livck.choices.status'))
                        .setValue('STATUS')
                        .setDefault(subscription.eventTypes.STATUS && !subscription.eventTypes.NEWS),
                    new StringSelectMenuOptionBuilder()
                        .setLabel(translation.trans('commands.livck.choices.news'))
                        .setValue('NEWS')
                        .setDefault(!subscription.eventTypes.STATUS && subscription.eventTypes.NEWS)
                );

            const localeSelectMenu = new StringSelectMenuBuilder()
                .setCustomId(`update_locale_${subscription.id}`)
                .setPlaceholder(translation.trans('commands.livck.list.edit_select_locale'))
                .addOptions(
                    new StringSelectMenuOptionBuilder()
                        .setLabel('🇩🇪 Deutsch')
                        .setValue('de')
                        .setDefault(subscription.locale === 'de'),
                    new StringSelectMenuOptionBuilder()
                        .setLabel('🇬🇧 English')
                        .setValue('en')
                        .setDefault(subscription.locale === 'en')
                );

            const layoutSelectMenu = new StringSelectMenuBuilder()
                .setCustomId(`update_layout_${subscription.id}`)
                .setPlaceholder(translation.trans('commands.livck.subscribe.select_layout'))
                .addOptions(
                    new StringSelectMenuOptionBuilder()
                        .setLabel(translation.trans('commands.livck.layouts.detailed.name'))
                        .setDescription(translation.trans('commands.livck.layouts.detailed.description'))
                        .setValue('DETAILED')
                        .setDefault(subscription.layout === 'DETAILED'),
                    new StringSelectMenuOptionBuilder()
                        .setLabel(translation.trans('commands.livck.layouts.compact.name'))
                        .setDescription(translation.trans('commands.livck.layouts.compact.description'))
                        .setValue('COMPACT')
                        .setDefault(subscription.layout === 'COMPACT'),
                    new StringSelectMenuOptionBuilder()
                        .setLabel(translation.trans('commands.livck.layouts.overview.name'))
                        .setDescription(translation.trans('commands.livck.layouts.overview.description'))
                        .setValue('OVERVIEW')
                        .setDefault(subscription.layout === 'OVERVIEW'),
                    // new StringSelectMenuOptionBuilder()
                    //     .setLabel(translation.trans('commands.livck.layouts.tree.name'))
                    //     .setDescription(translation.trans('commands.livck.layouts.tree.description'))
                    //     .setValue('TREE')
                    //     .setDefault(subscription.layout === 'TREE'),
                    new StringSelectMenuOptionBuilder()
                        .setLabel(translation.trans('commands.livck.layouts.minimal.name'))
                        .setDescription(translation.trans('commands.livck.layouts.minimal.description'))
                        .setValue('MINIMAL')
                        .setDefault(subscription.layout === 'MINIMAL')
                );

            const manageLinksButton = new ButtonBuilder()
                .setCustomId(`manage_links_${subscription.id}`)
                .setLabel(translation.trans('commands.livck.edit.manage_links_button'))
                .setStyle(ButtonStyle.Primary)

            const doneButton = new ButtonBuilder()
                .setCustomId('edit_done')
                .setLabel(translation.trans('commands.livck.edit.done_button'))
                .setStyle(ButtonStyle.Success)

            const eventRow = new ActionRowBuilder().addComponents(eventSelectMenu);
            const localeRow = new ActionRowBuilder().addComponents(localeSelectMenu);
            const layoutRow = new ActionRowBuilder().addComponents(layoutSelectMenu);
            const buttonRow = new ActionRowBuilder().addComponents(manageLinksButton, doneButton);

            await interaction.editReply({
                content: translation.trans('commands.livck.edit.editing', {
                    name: subscription.Statuspage.name || subscription.Statuspage.url,
                    channelId: subscription.channelId
                }),
                components: [eventRow, localeRow, layoutRow, buttonRow]
            });
        }

        // Handle link selection from select menu
        if (interaction.customId.startsWith('select_link_')) {
            const subscriptionId = interaction.customId.replace('select_link_', '');
            const linkId = interaction.values[0].replace('link_', '');

            await interaction.deferUpdate();

            const link = await models.CustomLink.findByPk(linkId);
            if (!link) {
                await interaction.followUp({
                    content: translation.trans('commands.livck.custom_links.error'),
                    ephemeral: true
                });
                return;
            }

            const subscription = await models.Subscription.findOne({
                where: { id: subscriptionId },
                include: [{ model: models.Statuspage }]
            });

            // Get link position info
            const allLinks = await models.CustomLink.findAll({
                where: { subscriptionId },
                order: [['position', 'ASC']]
            });

            const currentIndex = allLinks.findIndex(l => l.id === link.id);
            const canMoveUp = currentIndex > 0;
            const canMoveDown = currentIndex < allLinks.length - 1;

            // Show link details with edit/delete/move options
            const emoji = link.emoji || '🔗';
            // Wrap URL in backticks to prevent preview
            const linkInfo = `${emoji} **${link.label}**\n\`${link.url}\`\n\n${translation.trans('commands.livck.custom_links.position')}: ${currentIndex + 1}/${allLinks.length}`;

            const editButton = new ButtonBuilder()
                .setCustomId(`edit_link_${link.id}`)
                .setLabel(translation.trans('commands.livck.custom_links.edit_button'))
                .setStyle(ButtonStyle.Primary)

            const deleteButton = new ButtonBuilder()
                .setCustomId(`delete_link_${link.id}`)
                .setLabel(translation.trans('commands.livck.custom_links.delete_button'))
                .setStyle(ButtonStyle.Danger)

            const moveUpButton = new ButtonBuilder()
                .setCustomId(`move_link_up_${link.id}`)
                .setLabel(translation.trans('commands.livck.custom_links.move_up'))
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(!canMoveUp);

            const moveDownButton = new ButtonBuilder()
                .setCustomId(`move_link_down_${link.id}`)
                .setLabel(translation.trans('commands.livck.custom_links.move_down'))
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(!canMoveDown);

            const backButton = new ButtonBuilder()
                .setCustomId(`manage_links_${subscriptionId}`)
                .setLabel(translation.trans('commands.livck.custom_links.back_button'))
                .setStyle(ButtonStyle.Secondary)

            const actionRow1 = new ActionRowBuilder().addComponents(editButton, deleteButton);
            const actionRow2 = new ActionRowBuilder().addComponents(moveUpButton, moveDownButton);
            const actionRow3 = new ActionRowBuilder().addComponents(backButton);

            await interaction.editReply({
                content: translation.trans('commands.livck.custom_links.link_details', {
                    name: subscription.Statuspage.name || subscription.Statuspage.url
                }) + '\n\n' + linkInfo,
                components: [actionRow1, actionRow2, actionRow3]
            });
        }

        // Handle "Add Link" button
        if (interaction.customId.startsWith('add_link_')) {
            const subscriptionId = interaction.customId.replace('add_link_', '');

            // Show modal with 3 text inputs: label, url, emoji
            const modalPayload = {
                type: 9, // MODAL
                data: {
                    custom_id: `add_link_submit_${subscriptionId}`,
                    title: translation.trans('commands.livck.custom_links.modal_title_add'),
                    components: [
                        {
                            type: 1, // Action Row
                            components: [{
                                type: 4, // Text Input
                                custom_id: 'label',
                                style: 1, // Short
                                label: translation.trans('commands.livck.custom_links.modal_label_label'),
                                required: true,
                                max_length: 80
                            }]
                        },
                        {
                            type: 1,
                            components: [{
                                type: 4,
                                custom_id: 'url',
                                style: 1,
                                label: translation.trans('commands.livck.custom_links.modal_label_url'),
                                required: true,
                                placeholder: 'https://example.com'
                            }]
                        },
                        {
                            type: 1,
                            components: [{
                                type: 4,
                                custom_id: 'emoji',
                                style: 1,
                                label: translation.trans('commands.livck.custom_links.modal_label_emoji'),
                                required: false,
                                placeholder: '🔗'
                            }]
                        }
                    ]
                }
            };

            await interaction.client.rest.post(
                `/interactions/${interaction.id}/${interaction.token}/callback`,
                { body: modalPayload }
            );
        }

        // Handle "Edit Link" button
        if (interaction.customId.startsWith('edit_link_')) {
            const linkId = interaction.customId.replace('edit_link_', '');

            const link = await models.CustomLink.findByPk(linkId);
            if (!link) {
                await interaction.reply({
                    content: translation.trans('commands.livck.custom_links.error'),
                    ephemeral: true
                });
                return;
            }

            // Show modal with existing values pre-filled
            const modalPayload = {
                type: 9, // MODAL
                data: {
                    custom_id: `edit_link_submit_${link.id}`,
                    title: translation.trans('commands.livck.custom_links.modal_title_edit'),
                    components: [
                        {
                            type: 1,
                            components: [{
                                type: 4,
                                custom_id: 'label',
                                style: 1,
                                label: translation.trans('commands.livck.custom_links.modal_label_label'),
                                value: link.label,
                                required: true,
                                max_length: 80
                            }]
                        },
                        {
                            type: 1,
                            components: [{
                                type: 4,
                                custom_id: 'url',
                                style: 1,
                                label: translation.trans('commands.livck.custom_links.modal_label_url'),
                                value: link.url,
                                required: true
                            }]
                        },
                        {
                            type: 1,
                            components: [{
                                type: 4,
                                custom_id: 'emoji',
                                style: 1,
                                label: translation.trans('commands.livck.custom_links.modal_label_emoji'),
                                value: link.emoji || '',
                                required: false,
                                placeholder: '🔗'
                            }]
                        }
                    ]
                }
            };

            await interaction.client.rest.post(
                `/interactions/${interaction.id}/${interaction.token}/callback`,
                { body: modalPayload }
            );
        }

        // Handle "Delete Link" button
        if (interaction.customId.startsWith('delete_link_')) {
            const linkId = interaction.customId.replace('delete_link_', '');

            const link = await models.CustomLink.findByPk(linkId);
            if (!link) {
                await interaction.reply({
                    content: translation.trans('commands.livck.custom_links.error'),
                    ephemeral: true
                });
                return;
            }

            const subscriptionId = link.subscriptionId;
            await models.CustomLink.destroy({ where: { id: linkId } });

            // Defer update immediately to prevent timeout
            await interaction.deferUpdate();

            // Trigger status page refresh asynchronously
            const subscription = await models.Subscription.findOne({
                where: { id: subscriptionId },
                include: [{ model: models.Statuspage }]
            });

            if (subscription && subscription.Statuspage) {
                // Fire and forget
                handleStatusPage(subscription.Statuspage.id, client).catch(error => {
                    console.error('[Delete Link] Failed to refresh status page:', error);
                });
            }

            // Reload manage links view
            interaction.customId = `manage_links_${subscriptionId}`;
            await this.handleComponentInteraction(interaction, client);
        }

        // Handle "Move Link Up" button
        if (interaction.customId.startsWith('move_link_up_')) {
            const linkId = interaction.customId.replace('move_link_up_', '');

            await interaction.deferUpdate();

            const link = await models.CustomLink.findByPk(linkId);
            if (!link) {
                await interaction.followUp({
                    content: translation.trans('commands.livck.custom_links.error'),
                    ephemeral: true
                });
                return;
            }

            const allLinks = await models.CustomLink.findAll({
                where: { subscriptionId: link.subscriptionId },
                order: [['position', 'ASC']]
            });

            const currentIndex = allLinks.findIndex(l => l.id === link.id);
            if (currentIndex > 0) {
                // Swap positions with previous link
                const previousLink = allLinks[currentIndex - 1];
                const tempPosition = link.position;
                await link.update({ position: previousLink.position });
                await previousLink.update({ position: tempPosition });

                // Trigger status page refresh
                const subscription = await models.Subscription.findOne({
                    where: { id: link.subscriptionId },
                    include: [{ model: models.Statuspage }]
                });

                if (subscription && subscription.Statuspage) {
                    handleStatusPage(subscription.Statuspage.id, client).catch(error => {
                        console.error('[Move Link] Failed to refresh status page:', error);
                    });
                }
            }

            // Reload link details view with updated positions
            const updatedAllLinks = await models.CustomLink.findAll({
                where: { subscriptionId: link.subscriptionId },
                order: [['position', 'ASC']]
            });

            const subscription = await models.Subscription.findOne({
                where: { id: link.subscriptionId },
                include: [{ model: models.Statuspage }]
            });

            const updatedIndex = updatedAllLinks.findIndex(l => l.id === link.id);
            const canMoveUp = updatedIndex > 0;
            const canMoveDown = updatedIndex < updatedAllLinks.length - 1;

            const emoji = link.emoji || '🔗';
            const linkInfo = `${emoji} **${link.label}**\n\`${link.url}\`\n\n${translation.trans('commands.livck.custom_links.position')}: ${updatedIndex + 1}/${updatedAllLinks.length}`;

            const editButton = new ButtonBuilder()
                .setCustomId(`edit_link_${link.id}`)
                .setLabel(translation.trans('commands.livck.custom_links.edit_button'))
                .setStyle(ButtonStyle.Primary)

            const deleteButton = new ButtonBuilder()
                .setCustomId(`delete_link_${link.id}`)
                .setLabel(translation.trans('commands.livck.custom_links.delete_button'))
                .setStyle(ButtonStyle.Danger)

            const moveUpButton = new ButtonBuilder()
                .setCustomId(`move_link_up_${link.id}`)
                .setLabel(translation.trans('commands.livck.custom_links.move_up'))
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(!canMoveUp);

            const moveDownButton = new ButtonBuilder()
                .setCustomId(`move_link_down_${link.id}`)
                .setLabel(translation.trans('commands.livck.custom_links.move_down'))
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(!canMoveDown);

            const backButton = new ButtonBuilder()
                .setCustomId(`manage_links_${link.subscriptionId}`)
                .setLabel(translation.trans('commands.livck.custom_links.back_button'))
                .setStyle(ButtonStyle.Secondary)

            const actionRow1 = new ActionRowBuilder().addComponents(editButton, deleteButton);
            const actionRow2 = new ActionRowBuilder().addComponents(moveUpButton, moveDownButton);
            const actionRow3 = new ActionRowBuilder().addComponents(backButton);

            await interaction.editReply({
                content: translation.trans('commands.livck.custom_links.link_details', {
                    name: subscription.Statuspage.name || subscription.Statuspage.url
                }) + '\n\n' + linkInfo,
                components: [actionRow1, actionRow2, actionRow3]
            });
        }

        // Handle "Move Link Down" button
        if (interaction.customId.startsWith('move_link_down_')) {
            const linkId = interaction.customId.replace('move_link_down_', '');

            await interaction.deferUpdate();

            const link = await models.CustomLink.findByPk(linkId);
            if (!link) {
                await interaction.followUp({
                    content: translation.trans('commands.livck.custom_links.error'),
                    ephemeral: true
                });
                return;
            }

            const allLinks = await models.CustomLink.findAll({
                where: { subscriptionId: link.subscriptionId },
                order: [['position', 'ASC']]
            });

            const currentIndex = allLinks.findIndex(l => l.id === link.id);
            if (currentIndex < allLinks.length - 1) {
                // Swap positions with next link
                const nextLink = allLinks[currentIndex + 1];
                const tempPosition = link.position;
                await link.update({ position: nextLink.position });
                await nextLink.update({ position: tempPosition });

                // Trigger status page refresh
                const subscription = await models.Subscription.findOne({
                    where: { id: link.subscriptionId },
                    include: [{ model: models.Statuspage }]
                });

                if (subscription && subscription.Statuspage) {
                    handleStatusPage(subscription.Statuspage.id, client).catch(error => {
                        console.error('[Move Link] Failed to refresh status page:', error);
                    });
                }
            }

            // Reload link details view with updated positions
            const updatedAllLinks = await models.CustomLink.findAll({
                where: { subscriptionId: link.subscriptionId },
                order: [['position', 'ASC']]
            });

            const subscription = await models.Subscription.findOne({
                where: { id: link.subscriptionId },
                include: [{ model: models.Statuspage }]
            });

            const updatedIndex = updatedAllLinks.findIndex(l => l.id === link.id);
            const canMoveUp = updatedIndex > 0;
            const canMoveDown = updatedIndex < updatedAllLinks.length - 1;

            const emoji = link.emoji || '🔗';
            const linkInfo = `${emoji} **${link.label}**\n\`${link.url}\`\n\n${translation.trans('commands.livck.custom_links.position')}: ${updatedIndex + 1}/${updatedAllLinks.length}`;

            const editButton = new ButtonBuilder()
                .setCustomId(`edit_link_${link.id}`)
                .setLabel(translation.trans('commands.livck.custom_links.edit_button'))
                .setStyle(ButtonStyle.Primary)

            const deleteButton = new ButtonBuilder()
                .setCustomId(`delete_link_${link.id}`)
                .setLabel(translation.trans('commands.livck.custom_links.delete_button'))
                .setStyle(ButtonStyle.Danger)

            const moveUpButton = new ButtonBuilder()
                .setCustomId(`move_link_up_${link.id}`)
                .setLabel(translation.trans('commands.livck.custom_links.move_up'))
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(!canMoveUp);

            const moveDownButton = new ButtonBuilder()
                .setCustomId(`move_link_down_${link.id}`)
                .setLabel(translation.trans('commands.livck.custom_links.move_down'))
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(!canMoveDown);

            const backButton = new ButtonBuilder()
                .setCustomId(`manage_links_${link.subscriptionId}`)
                .setLabel(translation.trans('commands.livck.custom_links.back_button'))
                .setStyle(ButtonStyle.Secondary)

            const actionRow1 = new ActionRowBuilder().addComponents(editButton, deleteButton);
            const actionRow2 = new ActionRowBuilder().addComponents(moveUpButton, moveDownButton);
            const actionRow3 = new ActionRowBuilder().addComponents(backButton);

            await interaction.editReply({
                content: translation.trans('commands.livck.custom_links.link_details', {
                    name: subscription.Statuspage.name || subscription.Statuspage.url
                }) + '\n\n' + linkInfo,
                components: [actionRow1, actionRow2, actionRow3]
            });
        }

        // Handle "Done" button
        if (interaction.customId === 'edit_done') {
            await interaction.update({
                content: translation.trans('commands.livck.edit.completed'),
                components: []
            });
        }

        // Handle old unsubscribe button (from detail view)
        if (interaction.customId.startsWith('unsub_')) {
            const subscriptionId = interaction.customId.replace('unsub_', '');

            const subscription = await models.Subscription.findOne({
                where: { id: subscriptionId },
                include: [{ model: models.Statuspage }]
            });

            if (!subscription) {
                await interaction.reply({
                    content: translation.trans('commands.livck.list.subscription_not_found'),
                    ephemeral: true
                });
                return;
            }

            await models.Subscription.destroy({ where: { id: subscriptionId } });

            await interaction.update({
                content: translation.trans('commands.livck.unsubscribe.success', { url: subscription.Statuspage.url }),
                embeds: [],
                components: []
            });
        }
    },

    // Handle autocomplete
    async autocomplete(interaction, client) {
        const focusedOption = interaction.options.getFocused(true);

        if (focusedOption.name === 'subscription') {
            try {
                // Fetch all subscriptions for this guild
                const subscriptions = await models.Subscription.findAll({
                    where: { guildId: interaction.guildId },
                    include: [{ model: models.Statuspage }],
                    limit: 25
                });

                // Filter based on user input
                const filtered = subscriptions.filter(sub =>
                    sub.Statuspage.name.toLowerCase().includes(focusedOption.value.toLowerCase()) ||
                    sub.Statuspage.url.toLowerCase().includes(focusedOption.value.toLowerCase())
                );

                // Format choices
                const choices = filtered.map(sub => {
                    const channelName = interaction.guild.channels.cache.get(sub.channelId)?.name || 'deleted';
                    const langFlag = sub.locale === 'de' ? '🇩🇪' : '🇬🇧';

                    return {
                        name: `${sub.Statuspage.name} • #${channelName} • ${langFlag}`,
                        value: sub.id.toString()
                    };
                });

                await interaction.respond(choices.slice(0, 25));
            } catch (error) {
                console.error('Error in autocomplete:', error);
                await interaction.respond([]);
            }
        }
    },

    // Complete subscription after all selections are made
    async completeSubscription(interaction, client, data) {
        const userLocale = interaction.locale?.split('-')[0] || 'de';
        translation.setLocale(['de', 'en'].includes(userLocale) ? userLocale : 'de');

        try {
            let { url, channelId, events, locale, layout } = data;

            let eventTypes;
            switch (events) {
                case 'STATUS':
                    eventTypes = { STATUS: true, NEWS: false };
                    break;
                case 'NEWS':
                    eventTypes = { STATUS: false, NEWS: true };
                    break;
                default:
                    eventTypes = { STATUS: true, NEWS: true };
            }

            // Quick validation: Check if subscription already exists
            let statuspage = await models.Statuspage.findOne({ where: { url } });

            if (statuspage) {
                const existingSubscription = await models.Subscription.findOne({
                    where: {
                        guildId: interaction.guildId,
                        channelId: channelId,
                        statuspageId: statuspage.id,
                        locale: locale,
                    },
                });

                if (existingSubscription) {
                    const replyMethod = interaction.replied || interaction.deferred ? 'followUp' : 'reply';
                    await interaction[replyMethod]({
                        content: translation.trans('commands.livck.subscribe.already_subscribed', {
                            url,
                            channelId: channelId,
                            locale: locale.toUpperCase()
                        }),
                        flags: 64 // EPHEMERAL flag
                    });
                    return;
                }
            }

            // Create statuspage if it doesn't exist
            if (!statuspage) {
                statuspage = await models.Statuspage.create({ url, name: domainFromUrl(url) });
            }

            // Create subscription
            const subscription = await models.Subscription.create({
                guildId: interaction.guildId,
                channelId: channelId,
                statuspageId: statuspage.id,
                layout: layout || 'DETAILED',
                eventTypes: eventTypes,
                interval: 60,
                locale: locale,
            });

            console.log('Subscription created:', subscription.id, 'for statuspage:', statuspage.id);

            // IMPORTANT: Reply IMMEDIATELY before doing expensive operations
            const langFlag = locale === 'de' ? '🇩🇪' : '🇬🇧';
            const replyMethod = interaction.replied || interaction.deferred ? 'followUp' : 'reply';
            await interaction[replyMethod]({
                content: translation.trans('commands.livck.subscribe.success', {
                    url,
                    channelId: channelId,
                    flag: langFlag,
                    locale: locale.toUpperCase()
                }),
                flags: 64 // EPHEMERAL flag
            });

            // Now do expensive operations asynchronously (fire-and-forget)
            // Validate URL and fetch status page in background
            const livck = new LIVCK(url);
            livck.ensureIsLIVCK().then(async (isValid) => {
                if (!isValid) {
                    console.error('[Subscribe] Invalid LIVCK URL:', url);
                    // Delete the subscription if invalid
                    await models.Subscription.destroy({ where: { id: subscription.id } });
                    return;
                }

                // Fetch and render status page
                try {
                    await handleStatusPage(statuspage.id, client);
                    console.log('[Subscribe] handleStatusPage completed for statuspage:', statuspage.id);
                } catch (handleError) {
                    console.error('[Subscribe] Error in handleStatusPage:', handleError);
                }
            }).catch(error => {
                console.error('[Subscribe] Error validating LIVCK URL:', error);
            });

        } catch (error) {
            console.error('Error completing subscription:', error);
            const replyMethod = interaction.replied || interaction.deferred ? 'followUp' : 'reply';
            await interaction[replyMethod]({
                content: translation.trans('commands.livck.subscribe.error'),
                flags: 64 // EPHEMERAL flag
            });
        }
    },

    // Handle modal submits
    async handleModalSubmit(interaction, client) {
        const userLocale = interaction.locale?.split('-')[0] || 'de';
        translation.setLocale(['de', 'en'].includes(userLocale) ? userLocale : 'de');

        if (interaction.customId === 'subscribe_complete_modal') {
            try {
                // Extract values from Type 18 Label components
                const components = interaction.components || [];

                let url = null;
                let channelId = null;
                let events = 'ALL';
                let locale = userLocale;
                let layout = 'DETAILED';

                // Parse Type 18 components
                for (const component of components) {
                    // Type 18 has nested 'component' field
                    const actualComponent = component.component || component;

                    if (!actualComponent || !actualComponent.customId) continue;

                    if (actualComponent.customId === 'url') {
                        url = actualComponent.value;
                    } else if (actualComponent.customId === 'channel') {
                        channelId = actualComponent.values?.[0];
                    } else if (actualComponent.customId === 'events') {
                        const eventValue = actualComponent.values?.[0] || 'all';
                        events = eventValue === 'status' ? 'STATUS' : eventValue === 'news' ? 'NEWS' : 'ALL';
                    } else if (actualComponent.customId === 'locale') {
                        locale = actualComponent.values?.[0] || userLocale;
                    } else if (actualComponent.customId === 'layout') {
                        layout = actualComponent.values?.[0] || 'DETAILED';
                    }
                }

                // Validate we have all required fields
                if (!url || !channelId) {
                    await interaction.reply({
                        content: translation.trans('commands.livck.subscribe.error'),
                        flags: 64 // EPHEMERAL flag
                    });
                    return;
                }

                // Complete the subscription
                await this.completeSubscription(interaction, client, {
                    url: normalizeUrl(url, true),
                    channelId,
                    events,
                    locale,
                    layout
                });

            } catch (error) {
                console.error('Error processing subscribe modal:', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: translation.trans('commands.livck.subscribe.error'),
                        flags: 64 // EPHEMERAL flag
                    });
                }
            }
        }

        // Handle "Add Link" modal submit
        if (interaction.customId.startsWith('add_link_submit_')) {
            const subscriptionId = interaction.customId.replace('add_link_submit_', '');

            try {
                // Extract form values
                const label = interaction.fields.getTextInputValue('label');
                const url = interaction.fields.getTextInputValue('url');
                const emoji = interaction.fields.getTextInputValue('emoji') || null;

                // Validate URL
                if (!url.startsWith('http://') && !url.startsWith('https://')) {
                    await interaction.reply({
                        content: translation.trans('commands.livck.custom_links.invalid_url'),
                        flags: 64 // EPHEMERAL
                    });
                    return;
                }

                // Check max links
                const existingCount = await models.CustomLink.count({
                    where: { subscriptionId }
                });

                if (existingCount >= 25) {
                    await interaction.reply({
                        content: translation.trans('commands.livck.custom_links.max_links'),
                        flags: 64
                    });
                    return;
                }

                // Create link
                await models.CustomLink.create({
                    subscriptionId,
                    label: label.substring(0, 80),
                    url,
                    emoji,
                    position: existingCount
                });

                // IMPORTANT: Reply first before doing expensive operations
                await interaction.reply({
                    content: translation.trans('commands.livck.custom_links.added'),
                    flags: 64
                });

                // Trigger status page refresh asynchronously (don't await)
                const subscription = await models.Subscription.findOne({
                    where: { id: subscriptionId },
                    include: [{ model: models.Statuspage }]
                });

                if (subscription && subscription.Statuspage) {
                    console.log('[Add Link] Triggering status page refresh for', subscription.Statuspage.url);
                    // Fire and forget - don't await
                    handleStatusPage(subscription.Statuspage.id, client).catch(error => {
                        console.error('[Add Link] Failed to refresh status page:', error.message);
                    });
                }

            } catch (error) {
                console.error('[Add Link] Error adding custom link:', error.message);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: translation.trans('commands.livck.custom_links.error'),
                        flags: 64
                    });
                }
            }
        }

        // Handle Edit Link Modal Submit
        if (interaction.customId.startsWith('edit_link_submit_')) {
            const linkId = interaction.customId.replace('edit_link_submit_', '');

            try {
                const link = await models.CustomLink.findByPk(linkId);
                if (!link) {
                    await interaction.reply({
                        content: translation.trans('commands.livck.custom_links.error'),
                        flags: 64
                    });
                    return;
                }

                // Extract form values
                const label = interaction.fields.getTextInputValue('label');
                const url = interaction.fields.getTextInputValue('url');
                const emoji = interaction.fields.getTextInputValue('emoji') || null;

                // Validate URL
                if (!url.startsWith('http://') && !url.startsWith('https://')) {
                    await interaction.reply({
                        content: translation.trans('commands.livck.custom_links.invalid_url'),
                        flags: 64
                    });
                    return;
                }

                // Update link
                await link.update({
                    label: label.substring(0, 80),
                    url,
                    emoji
                });

                // IMPORTANT: Reply first
                await interaction.reply({
                    content: translation.trans('commands.livck.custom_links.updated'),
                    flags: 64
                });

                // Trigger status page refresh asynchronously
                const subscription = await models.Subscription.findOne({
                    where: { id: link.subscriptionId },
                    include: [{ model: models.Statuspage }]
                });

                if (subscription && subscription.Statuspage) {
                    handleStatusPage(subscription.Statuspage.id, client).catch(error => {
                        console.error('[Edit Link] Failed to refresh status page:', error);
                    });
                }

            } catch (error) {
                console.error('Error editing custom link:', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: translation.trans('commands.livck.custom_links.error'),
                        flags: 64
                    });
                }
            }
        }
    }
});
