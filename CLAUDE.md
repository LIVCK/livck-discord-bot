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
2. **Update Loop**: Processes status pages that are due (see backoff below) in batches of 100, checks Redis cache to prevent duplicate processing
3. **Handlers**: `handleStatusPage` and `handleAlerts` render and update Discord messages
4. **Providers**: `providers/index.js` detects which product a page runs and returns one snapshot
5. **DTO**: `dto/statuspage.js` — the single shape everything downstream reads

### Two backends, one model

A status page is either a **self-hosted** LIVCK instance or a **LIVCK Cloud** page. The bot
detects which from response headers (`lvk-version` vs. `server: LIVCK Cloud`) on first contact
and stores it on `Statuspage.kind`.

Both are normalized into `dto/statuspage.js` by an adapter (`providers/selfHosted.js`,
`providers/cloud.js`), so no renderer or handler knows the difference. The DTO uses the
Cloud's richer status vocabulary as its canon; self-hosted maps up into it.

Translatable fields (`name`, `title`, `body`) stay UNRESOLVED in the DTO. The Cloud ships
every language in one payload, so one fetch serves subscriptions in different languages —
resolution happens in the renderer via `resolveText()`.

`providers/index.js` memoizes a snapshot per (page, token, locale) for a few seconds, so
`handleStatusPage` and `handleAlerts` — which run concurrently for the same page — share one
fetch instead of two.

### Not hammering things

- **Discord** allows 50 requests/second per bot. Status messages are therefore only edited
  when their content actually changed (`Message.contentHash`), with a heartbeat refresh every
  `STATUS_REFRESH_MINUTES`.
- **Unreachable pages** climb a backoff ladder (30s → 6h) rather than being retried every
  cycle. Subscribers are told once, and the page resumes by itself. See
  `services/statuspagePauseManager.js`.
- **Embed limits** are enforced in `util/discordLimits.js`; Discord rejects an over-limit
  message whole, so an unguarded layout means the page posts nothing.

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

- **Private self-hosted pages** work via a per-subscription API token
- **Protected Cloud pages** (password / email whitelist) are NOT supported: every
  unauthenticated surface answers 404, and the alternative would mean storing a customer's
  status page password. `/livck subscribe` says so explicitly instead of failing silently.
- **Cloudflare Bot Shield/Tunnels not compatible** (some proxies with bot protection won't work)
- **Multi-language support** (English, German, + 11 community languages via Crowdin)