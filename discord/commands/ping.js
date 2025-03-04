export default (models) => ({
    data: {
        name: 'livck-ping',
        description: 'Replies with Pong!',
    },
    async execute(interaction, client) {
        await interaction.reply({ content: 'Hey there! I am alive! 🎉', ephemeral: true });
    },
});
