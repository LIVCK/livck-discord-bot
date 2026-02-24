# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-02-24

### Added

- **Role Mentions**: Configure Discord roles per subscription that get @mentioned on new alert/news messages
- Role mentions are configurable per event type (All Events, Status Only, News Only)
- "Manage Roles" button in the `/livck edit` flow with full CRUD UI (add, remove, event type selection)
- RoleSelectMenu for convenient role selection from the server's role list
- Up to 25 role mentions per subscription
- New database table `RoleMentions` with unique constraint and cascade delete
- Translations for English and German (13 new keys each)

### How it works

- Role pings only trigger on **new** NEWS/alert messages, not on status edits (Discord does not re-notify on `message.edit()`)
- Uses `allowedMentions: { roles: [...] }` with explicit IDs for safe mention handling
- Event type selection is stored temporarily in Redis (5 min TTL) and applied when roles are added
- No additional Discord intent required (`GatewayIntentBits.Guilds` is sufficient)

### Migration required

```bash
node migrate.js
```

## [1.0.0] - 2025-09-30

### Added

- Initial release
- Status page monitoring with automatic updates (15-second interval)
- Alert/incident notifications for NEWS events
- Subscription management per Discord channel via `/livck` slash commands
- Message persistence (edits existing messages instead of creating new ones)
- Custom links per subscription with drag-and-drop reordering
- Multi-language support (English, German)
- Multiple layout options (Detailed, Compact, Overview, Minimal)
- Redis-based caching and lock system
- Sequelize ORM with MariaDB and Umzug migration system

[1.1.0]: https://github.com/LIVCK/livck-discord-bot/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/LIVCK/livck-discord-bot/releases/tag/v1.0.0
