# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Groundwork for the LIVCK Cloud integration. Nothing here is Cloud-specific — all of it fixes
behaviour that affects self-hosted status pages today.

### Fixed

- **Automatic pausing never triggered.** Two independent causes: `LIVCK.get()` returned
  `{data: []}` on every error instead of throwing (so an unreachable page looked like an empty
  one), and `server.js` did not load `failureCount`/`lastFailure`, leaving the counter
  `undefined` — `undefined + 1` is `NaN`, and `NaN >= 3` is never true.
- **No Discord limit guards.** Layouts could exceed 25 fields, 1024 characters per field or the
  6000-character message budget. Discord rejects such a message wholesale, so an affected status
  page posted nothing at all.
- **A transient fetch failure wiped the status message**, replacing a good embed with "no
  categories available". The last known good content is now kept.
- Requests had no deadline; a stalled connection could hold up a cycle for minutes without ever
  surfacing as an error. Now capped by `LIVCK_TIMEOUT_MS` (default 10s).

### Changed

- **Status messages are only edited when they actually change.** Each `Message` stores a hash of
  its last payload. Combined with dropping the redundant `channel.messages.fetch()` before every
  edit, this removes almost all Discord API traffic in steady state — the bot was previously
  spending two calls per subscription per cycle against a 50 req/s account-wide budget, which
  capped it near 375 subscriptions. A heartbeat edit still refreshes the timestamp every
  `STATUS_REFRESH_MINUTES` (default 15).
- **Pausing is now a backoff ladder** (30s → 1m → 5m → 15m → 1h → 6h) instead of a dead end.
  Subscribers are notified once, roughly 21 minutes into a sustained outage, and the page resumes
  by itself — with a recovery notice — as soon as it answers again. `/livck resume` still forces
  an immediate retry.
- Pause and resume notifications are sent in each subscription's own language instead of one
  bilingual embed.
- `Statuspage.pauseReason` is a `VARCHAR(32)` rather than an `ENUM`, and covers the full failure
  vocabulary (`TIMEOUT`, `DNS`, `REFUSED`, `TLS`, `HTTP_4XX`, `HTTP_5XX`, `RATE_LIMITED`,
  `NOT_LIVCK`, `NETWORK`, `UNKNOWN`).
- **Logging is leveled** via `LOG_LEVEL` (default `info`). Per-statuspage chatter moved to
  `debug`, leaving one summary line per cycle. Expected network failures log a single line with
  no stack trace, and repeats for the same page are suppressed until the message changes — a
  dead domain went from ~5760 log entries a day to roughly ten.
- Discord rate limiting is now reported through a `rateLimited` listener; previously discord.js
  queued silently and the only symptom was updates arriving later and later.

### Added

- `util/errors.js`, `util/logger.js`, `util/discordLimits.js`, `util/messageSync.js` and
  `util/subscriptionGroups.js`.
- Golden-output snapshot tests pinning every layout's rendering, so the upcoming refactor cannot
  silently change what customers see.
- API client contract tests now run against a stubbed `fetch`. The live checks against
  `status.livck.com` are opt-in via `LIVCK_LIVE_TESTS=1`, so a third-party outage no longer
  fails CI.

### Migration required

```bash
node migrate.js
```

Adds `Messages.contentHash`, `Statuspages.backoffLevel` and `Statuspages.nextAttemptAt`, and
converts `Statuspages.pauseReason` from `ENUM` to `VARCHAR(32)`. Existing rows need no backfill.

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
