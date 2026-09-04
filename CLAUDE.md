# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LIVCK Discord Bot is a self-hosted Discord bot that monitors LIVCK status pages and sends updates to Discord channels. It fetches monitor statuses, categories, and alerts from LIVCK status page APIs and displays them as Discord embeds.

**Key Features:**
- Status page monitoring with automatic updates
- Alert/incident notifications
- Subscription management per Discord channel
- Message persistence (edits existing messages rather than spamming new ones)

## Architecture

### Core Flow
1. **server.js**: Main entry point that initializes the bot and runs the update loop (15-second interval)
2. **Update Loop**: Processes all status pages in batches of 100, checks Redis cache to prevent duplicate processing
3. **Handlers**: `handleStatusPage` and `handleAlerts` fetch data and update Discord messages
4. **Services**: `statuspage.js` wraps the LIVCK API client to fetch categories, monitors, and alerts
5. **API Client**: `api/livck.js` handles HTTP requests to LIVCK status page APIs

### Database Architecture
- **Sequelize ORM** with MariaDB
- **Redis** for caching/locking (prevents concurrent processing of same status page)
- **Models**:
  - `Statuspage`: Stores status page URLs
  - `Subscription`: Links status pages to Discord channels with event type filters
  - `Message`: Tracks Discord message IDs for editing instead of creating new messages

### Discord Bot Structure
- **discord/bot.js**: Initializes Discord client, loads commands, registers slash commands
- **discord/commands/**: Slash command implementations (e.g., `/livck`, `/ping`)
- **messages/layoutRenderers.js**: Renders Discord embeds from a snapshot (see `dto/statuspage.js`)

## Commands

**Run the bot:**
```bash
node server.js
```

**Run database migrations:**
```bash
node migrate.js
```

## Environment Variables

Required variables (see `.env.example`):
- `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`
- `DB_HOST`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD`
- `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`

## Development Notes

- **ES Modules**: Project uses `"type": "module"` in package.json
- **No TypeScript**: Pure JavaScript codebase
- **No build step**: Bot runs directly with Node.js
- **Migration System**: Uses Umzug for database migrations (Sequelize-based)
- **Command Registration**: Slash commands are automatically registered on bot startup via Discord API

## Important Constraints

- **Private LIVCK pages not supported** (no API token support yet)
- **Cloudflare Bot Shield/Tunnels not compatible** (some proxies with bot protection won't work)
- **Multi-language support** (English, German, + 11 community languages via Crowdin)