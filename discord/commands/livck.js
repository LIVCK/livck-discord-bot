import { domainFromUrl, normalizeUrl } from "../../util/String.js";
import { handleStatusPage } from "../../handlers/handleStatuspage.js";
import LIVCK from "../../api/livck.js";
import translation from "../../util/Translation.js";

export default (models) => ({
    data: {
        name: 'livck',
        description: translation.trans('commands.livck.description', {}, null, 'en'),
        description_localizations: translation.localizeExcept('commands.livck.description'),
        options: [
            {
                type: 1, // Subcommand
                name: 'subscribe',
                description: translation.trans('commands.livck.subcommands.subscribe.description', {}, null, 'en'),
                description_localizations: translation.localizeExcept('commands.livck.subcommands.subscribe.description'),
                options: [
                    {
                        type: 3,
                        name: 'url',
                        description: translation.trans('commands.livck.options.url.description', {}, null, 'en'),
                        description_localizations: translation.localizeExcept('commands.livck.options.url.description'),
                        required: true
                    },
                    {
                        type: 7,
                        name: 'channel',
                        description: translation.trans('commands.livck.options.channel.description', {}, null, 'en'),
                        description_localizations: translation.localizeExcept('commands.livck.options.channel.description'),
                        required: true
                    },
                    {
                        type: 3,
                        name: 'events',
                        description: translation.trans('commands.livck.options.events.description', {}, null, 'en'),
                        description_localizations: translation.localizeExcept('commands.livck.options.events.description'),
                        required: true,
                        choices: [
                            {
                                name: translation.trans('commands.livck.choices.all', {}, null, 'en'),
                                name_localizations: translation.localizeExcept('commands.livck.choices.all'),
                                value: 'ALL'
                            },
                            {
                                name: translation.trans('commands.livck.choices.status', {}, null, 'en'),
                                name_localizations: translation.localizeExcept('commands.livck.choices.status'),
                                value: 'STATUS'
                            },
                            {
                                name: translation.trans('commands.livck.choices.news', {}, null, 'en'),
                                name_localizations: translation.localizeExcept('commands.livck.choices.news'),
                                value: 'NEWS'
                            },
                        ],
                    },
                    {
                        type: 3,
                        name: 'locale',
                        description: translation.trans('commands.livck.options.locale.description', {}, null, 'en'),
                        description_localizations: translation.localizeExcept('commands.livck.options.locale.description'),
                        required: false,
                        choices: [
                            { name: '🇩🇪 Deutsch', value: 'de' },
                            { name: '🇬🇧 English', value: 'en' },
                        ],
                    },
                ],
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
        ],
    },
    async execute(interaction, client) {
        const subcommand = interaction.options.getSubcommand();

        switch (subcommand) {
            case 'subscribe': {
                let url = interaction.options.getString('url');
                const channel = interaction.options.getChannel('channel');
                const locale = interaction.options.getString('locale') || 'de';

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
                    // Determine user's locale for command response
                    const userLocale = interaction.locale?.split('-')[0] || 'de';
                    translation.setLocale(['de', 'en'].includes(userLocale) ? userLocale : 'de');

                    url = normalizeUrl(url, true);

                    let livck = new LIVCK(url);
                    if (!await livck.ensureIsLIVCK()) {
                        await interaction.reply({
                            content: translation.trans('commands.livck.subscribe.invalid_url'),
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
                            locale: locale,
                        },
                    });

                    if (existingSubscription) {
                        await interaction.reply({
                            content: translation.trans('commands.livck.subscribe.already_subscribed', {
                                url,
                                channelId: channel.id,
                                locale: locale.toUpperCase()
                            }),
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
                        locale: locale,
                    });

                    await handleStatusPage(statuspage.id, client)

                    const langFlag = locale === 'de' ? '🇩🇪' : '🇬🇧';
                    await interaction.reply({
                        content: translation.trans('commands.livck.subscribe.success', {
                            url,
                            channelId: channel.id,
                            flag: langFlag,
                            locale: locale.toUpperCase()
                        }),
                        ephemeral: true,
                    });
                } catch (error) {
                    console.error('Error creating subscription:', error);
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

                    const fields = subscriptions.map((sub) => {
                        const langFlag = sub.locale === 'de' ? '🇩🇪' : '🇬🇧';
                        const events = Object.keys(sub.eventTypes).filter(key => sub.eventTypes[key]).join(', ');

                        return {
                            name: sub.Statuspage.name,
                            value: `**${translation.trans('commands.livck.list.statuspage_label')}:** [${sub.Statuspage.name}](${sub.Statuspage.url})\n**${translation.trans('commands.livck.list.events_label')}:** ${events}\n**${translation.trans('commands.livck.list.channel_label')}:** <#${sub.channelId}>\n**${translation.trans('commands.livck.list.language_label')}:** ${langFlag} ${sub.locale.toUpperCase()}\n\n`,
                        };
                    });

                    await interaction.reply({
                        embeds: [
                            {
                                title: translation.trans('commands.livck.list.title'),
                                fields,
                                color: 0x00ff00,
                            },
                        ],
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

            default:
                await interaction.reply({
                    content: 'Unknown subcommand. Use `/livck` to see available subcommands.',
                    ephemeral: true,
                });
        }
    },
});
