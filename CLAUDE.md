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
1. **server.js**: Entry point — validates the environment, applies pending migrations,
   connects Discord, hands the client to the update loop, and shuts all of it down on SIGTERM
2. **services/updateLoop.js**: The 15-second cycle. Processes status pages that are due (see
   backoff below) in batches of 100, checks Redis cache to prevent duplicate processing. It
   lives outside `server.js` so it can be tested without a Discord token
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
  cycle. Nothing is posted about it: the status message that is already in the channel has
  the one word in its footer replaced by "inaktiv", and the page resumes by itself with no
  announcement at all. See `services/statuspagePauseManager.js`.
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

The Docker image does this itself (`docker/entrypoint.sh`) and refuses to start the bot if it
fails — the update loop selects columns that only exist after migrating, and a bot running
against an un-migrated database fails every query silently for ever.

**End-to-end run against the real status pages** (needs a throwaway database — it truncates
every table it uses, so never point it at one you care about):

```bash
docker exec mariadb mariadb -u root -e "CREATE DATABASE IF NOT EXISTS livck_bot_e2e"
DB_HOST=127.0.0.1 DB_DATABASE=livck_bot_e2e DB_USERNAME=root DB_PASSWORD= node migrate.js

LIVCK_E2E=1 DB_HOST=127.0.0.1 DB_DATABASE=livck_bot_e2e DB_USERNAME=root DB_PASSWORD= \
  npm test -- __tests__/e2e/pipeline.live.test.js
```

Everything except the Discord transport executes: detection, both adapters, the DTO, all five
layouts in both languages, the message-sync decisions and every database write. It is what
catches the class of bug fixtures cannot — a group that renders as an empty heading, a
translation key that leaks as itself, a second cycle that sends when it should stay silent.

**Against a real Discord bot** (needs a throwaway application, guild and database — see the
header of `__tests__/e2e/discord.live.test.js` for the setup, including the four permissions
the bot actually needs):

```bash
docker exec mariadb mariadb -u root -e "CREATE DATABASE IF NOT EXISTS livck_bot_discord"
DB_HOST=127.0.0.1 DB_DATABASE=livck_bot_discord DB_USERNAME=root DB_PASSWORD= node migrate.js

LIVCK_DISCORD_E2E=1 DB_HOST=127.0.0.1 DB_DATABASE=livck_bot_discord DB_USERNAME=root \
  DB_PASSWORD= REDIS_HOST=127.0.0.1 REDIS_PORT=6379 REDIS_PASSWORD= \
  npm test -- __tests__/e2e/discord.live.test.js --runInBand
```

Credentials come from `.env.test`, which `.gitignore` already covers. This is the only test
that proves Discord ACCEPTS what the bot builds — everything else validates the payload
locally and records what would have been sent. It skips itself when `.env.test` is absent, and
refuses to run against a database whose name does not look like a throwaway.

**Contract checks against the live APIs** (network only, no database):

```bash
LIVCK_LIVE_TESTS=1 npm test -- __tests__/providers/live.test.js
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