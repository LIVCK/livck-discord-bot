import translation from "../../util/Translation.js";

export default (models) => ({
    data: {
        name: 'livck-ping',
        description: translation.trans('commands.ping.description', {}, null, 'en'),
        description_localizations: translation.localizeExcept('commands.ping.description'),
        dm_permission: true, // Can be used in DMs
    },
    async execute(interaction, client) {
        // Detect user's locale
        const userLocale = interaction.locale?.split('-')[0] || 'de';
        translation.setLocale(['de', 'en'].includes(userLocale) ? userLocale : 'de');

        await interaction.reply({
            content: translation.trans('commands.ping.response'),
            ephemeral: true
        });
    },
});
