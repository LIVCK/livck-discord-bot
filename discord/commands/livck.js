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
        ],
    },
    async execute(interaction, client) {
        const subcommand = interaction.options.getSubcommand();

        // Check permissions for write operations
        if (['subscribe', 'unsubscribe', 'edit'].includes(subcommand)) {
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

                    // Create modal with text inputs only (select menus not supported in modals)
                    const modal = new ModalBuilder()
                        .setCustomId('subscribe_complete_modal')
                        .setTitle(translation.trans('commands.livck.subscribe.modal_title'));

                    // URL input
                    const urlInput = new TextInputBuilder()
                        .setCustomId('url')
                        .setLabel(translation.trans('commands.livck.subscribe.modal_url_label'))
                        .setStyle(TextInputStyle.Short)
                        .setPlaceholder('https://status.example.com')
                        .setRequired(true);

                    // Events input (text input)
                    const eventsInput = new TextInputBuilder()
                        .setCustomId('events')
                        .setLabel(translation.trans('commands.livck.subscribe.modal_events_label'))
                        .setStyle(TextInputStyle.Short)
                        .setPlaceholder('all / status / news')
                        .setValue('all')
                        .setRequired(false);

                    // Locale input (text input)
                    const localeInput = new TextInputBuilder()
                        .setCustomId('locale')
                        .setLabel(translation.trans('commands.livck.subscribe.modal_locale_label'))
                        .setStyle(TextInputStyle.Short)
                        .setPlaceholder('de / en')
                        .setValue(userLocale)
                        .setRequired(false);

                    const urlRow = new ActionRowBuilder().addComponents(urlInput);
                    const eventsRow = new ActionRowBuilder().addComponents(eventsInput);
                    const localeRow = new ActionRowBuilder().addComponents(localeInput);

                    modal.addComponents(urlRow, eventsRow, localeRow);

                    await interaction.showModal(modal);
                } catch (error) {
                    console.error('Error showing subscribe modal:', error);
                    await interaction.reply({
                        content: translation.trans('commands.livck.subscribe.error'),
                        ephemeral: true,
                    });
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

                    const eventRow = new ActionRowBuilder().addComponents(eventSelectMenu);
                    const localeRow = new ActionRowBuilder().addComponents(localeSelectMenu);

                    // Action buttons
                    const deleteButton = new ButtonBuilder()
                        .setCustomId(`delete_sub_${subscription.id}`)
                        .setLabel(translation.trans('commands.livck.list.delete_button'))
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji('🗑️');

                    const doneButton = new ButtonBuilder()
                        .setCustomId('edit_done')
                        .setLabel(translation.trans('commands.livck.edit.done_button'))
                        .setStyle(ButtonStyle.Success)
                        .setEmoji('✅');

                    const buttonRow = new ActionRowBuilder().addComponents(deleteButton, doneButton);

                    await interaction.reply({
                        components: [eventRow, localeRow, buttonRow],
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

        // Handle final subscribe channel selection
        if (interaction.customId.startsWith('subscribe_final_')) {
            const dataBase64 = interaction.customId.replace('subscribe_final_', '');
            const data = JSON.parse(Buffer.from(dataBase64, 'base64').toString('utf-8'));
            const channelId = interaction.channels.first().id;

            data.channelId = channelId;
            await this.completeSubscription(interaction, client, data);
            return;
        }

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
                .setEmoji('🔗');

            const unsubButton = new ButtonBuilder()
                .setCustomId(`unsub_${subscription.id}`)
                .setLabel(translation.trans('commands.livck.list.unsubscribe_button'))
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🗑️');

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
            const subscriptionId = interaction.customId.replace('delete_sub_', '');

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

        // Handle event type update
        if (interaction.customId.startsWith('update_events_')) {
            const subscriptionId = interaction.customId.replace('update_events_', '');
            const newEventType = interaction.values[0];

            let eventTypes;
            switch (newEventType) {
                case 'STATUS':
                    eventTypes = { STATUS: true, NEWS: false };
                    break;
                case 'NEWS':
                    eventTypes = { STATUS: false, NEWS: true };
                    break;
                default:
                    eventTypes = { STATUS: true, NEWS: true };
            }

            await models.Subscription.update(
                { eventTypes },
                { where: { id: subscriptionId } }
            );

            // Reload the edit interface with updated values
            const subscription = await models.Subscription.findOne({
                where: { id: subscriptionId },
                include: [{ model: models.Statuspage }]
            });

            // Rebuild select menus with new values
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

            const eventRow = new ActionRowBuilder().addComponents(eventSelectMenu);
            const localeRow = new ActionRowBuilder().addComponents(localeSelectMenu);

            const deleteButton = new ButtonBuilder()
                .setCustomId(`delete_sub_${subscription.id}`)
                .setLabel(translation.trans('commands.livck.list.delete_button'))
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🗑️');

            const doneButton = new ButtonBuilder()
                .setCustomId('edit_done')
                .setLabel(translation.trans('commands.livck.edit.done_button'))
                .setStyle(ButtonStyle.Success)
                .setEmoji('✅');

            const buttonRow = new ActionRowBuilder().addComponents(deleteButton, doneButton);

            await interaction.update({
                components: [eventRow, localeRow, buttonRow]
            });
        }

        // Handle locale update
        if (interaction.customId.startsWith('update_locale_')) {
            const subscriptionId = interaction.customId.replace('update_locale_', '');
            const newLocale = interaction.values[0];

            await models.Subscription.update(
                { locale: newLocale },
                { where: { id: subscriptionId } }
            );

            // Reload the edit interface with updated values
            const subscription = await models.Subscription.findOne({
                where: { id: subscriptionId },
                include: [{ model: models.Statuspage }]
            });

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

            const eventRow = new ActionRowBuilder().addComponents(eventSelectMenu);
            const localeRow = new ActionRowBuilder().addComponents(localeSelectMenu);

            const deleteButton = new ButtonBuilder()
                .setCustomId(`delete_sub_${subscription.id}`)
                .setLabel(translation.trans('commands.livck.list.delete_button'))
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🗑️');

            const doneButton = new ButtonBuilder()
                .setCustomId('edit_done')
                .setLabel(translation.trans('commands.livck.edit.done_button'))
                .setStyle(ButtonStyle.Success)
                .setEmoji('✅');

            const buttonRow = new ActionRowBuilder().addComponents(deleteButton, doneButton);

            await interaction.update({
                components: [eventRow, localeRow, buttonRow]
            });
        }

        // Handle "Done" button
        if (interaction.customId === 'edit_done') {
            await interaction.update({
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
            const { url, channelId, events, locale } = data;

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

            let statuspage = await models.Statuspage.findOne({ where: { url } });
            if (!statuspage) {
                statuspage = await models.Statuspage.create({ url, name: domainFromUrl(url) });
            }

            const existingSubscription = await models.Subscription.findOne({
                where: {
                    guildId: interaction.guildId,
                    channelId: channelId,
                    statuspageId: statuspage.id,
                    locale: locale,
                },
            });

            if (existingSubscription) {
                await interaction.update({
                    content: translation.trans('commands.livck.subscribe.already_subscribed', {
                        url,
                        channelId: channelId,
                        locale: locale.toUpperCase()
                    }),
                    components: []
                });
                return;
            }

            await models.Subscription.create({
                guildId: interaction.guildId,
                channelId: channelId,
                statuspageId: statuspage.id,
                eventTypes: eventTypes,
                interval: 60,
                locale: locale,
            });

            await handleStatusPage(statuspage.id, client);

            const langFlag = locale === 'de' ? '🇩🇪' : '🇬🇧';
            await interaction.update({
                content: translation.trans('commands.livck.subscribe.success', {
                    url,
                    channelId: channelId,
                    flag: langFlag,
                    locale: locale.toUpperCase()
                }),
                components: []
            });
        } catch (error) {
            console.error('Error completing subscription:', error);
            await interaction.update({
                content: translation.trans('commands.livck.subscribe.error'),
                components: []
            });
        }
    },

    // Handle modal submits
    async handleModalSubmit(interaction, client) {
        const userLocale = interaction.locale?.split('-')[0] || 'de';
        translation.setLocale(['de', 'en'].includes(userLocale) ? userLocale : 'de');

        if (interaction.customId === 'subscribe_complete_modal') {
            let url = interaction.fields.getTextInputValue('url');
            const eventsInput = (interaction.fields.getTextInputValue('events') || 'all').toLowerCase().trim();
            const localeInput = (interaction.fields.getTextInputValue('locale') || userLocale).toLowerCase().trim();

            // Parse events
            let events;
            if (eventsInput.includes('status')) {
                events = 'STATUS';
            } else if (eventsInput.includes('news') || eventsInput.includes('neuigkeiten')) {
                events = 'NEWS';
            } else {
                events = 'ALL';
            }

            // Parse locale
            const locale = ['de', 'en'].includes(localeInput) ? localeInput : userLocale;

            try {
                // Normalize and validate URL
                url = normalizeUrl(url, true);

                let livck = new LIVCK(url);
                if (!await livck.ensureIsLIVCK()) {
                    await interaction.reply({
                        content: translation.trans('commands.livck.subscribe.invalid_url'),
                        ephemeral: true,
                    });
                    return;
                }

                // Show channel select (Channel Select can't be in modal)
                const channelSelect = new ChannelSelectMenuBuilder()
                    .setCustomId(`subscribe_final_${Buffer.from(JSON.stringify({url, events, locale})).toString('base64')}`)
                    .setPlaceholder(translation.trans('commands.livck.subscribe.select_channel'))
                    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

                const channelRow = new ActionRowBuilder().addComponents(channelSelect);

                await interaction.reply({
                    content: translation.trans('commands.livck.subscribe.select_channel_final', { url }),
                    components: [channelRow],
                    ephemeral: true
                });
            } catch (error) {
                console.error('Error processing subscribe modal:', error);
                await interaction.reply({
                    content: translation.trans('commands.livck.subscribe.error'),
                    ephemeral: true,
                });
            }
        }
    }
});
