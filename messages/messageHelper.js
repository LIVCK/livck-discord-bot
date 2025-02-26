import { EmbedBuilder } from "discord.js";
import { truncate } from "../util/String.js";
import { htmlToText } from "html-to-text";

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

// export const getStatus = (status) => {
//     switch (status) {
//         case 'AVAILABLE':
//             return 'Verfügbar';
//         case 'UNAVAILABLE':
//             return 'Nicht verfügbar';
//         default:
//             return '-/-';
//     }
// };

export const generateStatusFields = (categories) => {
    return categories.map((category) => ({
        name: `${category.name}`,
        value: Object.values(category.monitors)
            .map((monitor) => {
                const emoji = getStatusEmoji(monitor.state);
                // const status = getStatus(monitor.state);
                return `${emoji} **${monitor.name}**`;
            })
            .join('\n') || 'Keine Dienste vorhanden.',
    }));
};

export const generateEmbed = (statuspageService, statuspage) => {
    const fields = generateStatusFields(statuspageService.categories);

    return new EmbedBuilder()
        .setTitle(`Dienste von ${statuspage.name}`)
        .setFields(fields)
        .setURL(statuspage.url)
        .setTimestamp(new Date())
        .setFooter({ text: statuspage.name });
};
