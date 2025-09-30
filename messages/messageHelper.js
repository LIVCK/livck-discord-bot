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
    if (!categories || !Array.isArray(categories)) {
        return [{ name: 'Fehler', value: 'Keine Kategorien verfügbar.' }];
    }

    return categories.map((category) => {
        const monitors = Array.isArray(category.monitors) ? category.monitors : [];
        const monitorList = monitors
            .map((monitor) => {
                const emoji = getStatusEmoji(monitor.state);
                return `${emoji} **${monitor.name}**`;
            })
            .join('\n') || 'Keine Dienste vorhanden.';

        return {
            name: `${category.name || 'Unbekannte Kategorie'}`,
            value: monitorList
        };
    });
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
