import { EmbedBuilder } from "discord.js";
import { truncate } from "../util/String.js";
import { htmlToText } from "html-to-text";
import translation from "../util/Translation.js";

export const getStatusEmoji = (status) => {
    switch (status) {
        case 'AVAILABLE':
            return '<a:status_up:1344187859921535047>';
        case 'UNAVAILABLE':
            return '<a:status_down:1344187930499088394>';
        default:
            return '-/-';
    }
};

export const generateStatusFields = (categories, locale = 'de') => {
    translation.setLocale(locale);

    if (!categories || !Array.isArray(categories)) {
        return [{
            name: translation.trans('messages.status.error'),
            value: translation.trans('messages.status.no_categories')
        }];
    }

    return categories.map((category) => {
        const monitors = Array.isArray(category.monitors) ? category.monitors : [];
        const monitorList = monitors
            .map((monitor) => {
                const emoji = getStatusEmoji(monitor.state);
                return `${emoji} **${monitor.name}**`;
            })
            .join('\n') || translation.trans('messages.status.no_services');

        return {
            name: category.name || translation.trans('messages.status.unknown_category'),
            value: monitorList
        };
    });
};

export const generateEmbed = (statuspageService, statuspage, locale = 'de') => {
    translation.setLocale(locale);

    const fields = generateStatusFields(statuspageService.categories, locale);
    const title = translation.trans('messages.status.title', { name: statuspage.name });

    return new EmbedBuilder()
        .setTitle(title)
        .setFields(fields)
        .setURL(statuspage.url)
        .setTimestamp(new Date())
        .setFooter({ text: statuspage.name });
};
