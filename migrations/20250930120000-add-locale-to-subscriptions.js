export default {
    async up(queryInterface, Sequelize) {
        console.log('Adding locale column to Subscriptions table...');

        // STEP 1: Add locale column (nullable first for existing data)
        await queryInterface.addColumn('Subscriptions', 'locale', {
            type: Sequelize.STRING(5),
            allowNull: true,
            defaultValue: null
        });
        console.log('✓ Column added');

        // STEP 2: Set all existing subscriptions to 'de' (default)
        await queryInterface.sequelize.query(
            `UPDATE Subscriptions SET locale = 'de' WHERE locale IS NULL`
        );
        console.log('✓ Existing subscriptions set to "de"');

        // STEP 3: Make column NOT NULL with default
        await queryInterface.changeColumn('Subscriptions', 'locale', {
            type: Sequelize.STRING(5),
            allowNull: false,
            defaultValue: 'de'
        });
        console.log('✓ Column set to NOT NULL');

        // STEP 4: Drop old UNIQUE constraint
        await queryInterface.removeConstraint(
            'Subscriptions',
            'unique_guild_channel_statuspage'
        );
        console.log('✓ Old UNIQUE constraint removed');

        // STEP 5: Add new UNIQUE constraint with locale
        await queryInterface.addConstraint('Subscriptions', {
            fields: ['guildId', 'channelId', 'statuspageId', 'locale'],
            type: 'unique',
            name: 'unique_guild_channel_statuspage_locale'
        });
        console.log('✓ New UNIQUE constraint added');

        // STEP 6: Add index for performance
        await queryInterface.addIndex('Subscriptions', ['locale'], {
            name: 'subscriptions_locale_idx'
        });
        console.log('✓ Index added for locale column');

        console.log('Migration completed successfully!');
    },

    async down(queryInterface, Sequelize) {
        console.log('Rolling back locale addition...');

        // Remove index
        await queryInterface.removeIndex('Subscriptions', 'subscriptions_locale_idx');
        console.log('✓ Index removed');

        // Drop new UNIQUE constraint
        await queryInterface.removeConstraint(
            'Subscriptions',
            'unique_guild_channel_statuspage_locale'
        );
        console.log('✓ New UNIQUE constraint removed');

        // Restore old UNIQUE constraint
        await queryInterface.addConstraint('Subscriptions', {
            fields: ['guildId', 'channelId', 'statuspageId'],
            type: 'unique',
            name: 'unique_guild_channel_statuspage'
        });
        console.log('✓ Old UNIQUE constraint restored');

        // Remove locale column
        await queryInterface.removeColumn('Subscriptions', 'locale');
        console.log('✓ Locale column removed');

        console.log('Rollback completed successfully!');
    }
};