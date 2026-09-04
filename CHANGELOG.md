# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

LIVCK Cloud support, plus the groundwork it needed — several fixes that affect self-hosted
status pages just as much.

### Added

- **LIVCK Cloud status pages.** Which product a page runs is detected from response headers on
  first contact and stored, so `/livck subscribe` is unchanged for customers: paste a URL, done.
  Gated behind `CLOUD_ENABLED` (off by default) while Cloud news handling is still incomplete.
- Cloud component trees nest up to five levels; Discord offers two. The tree is folded onto
  top-level groups and the remaining depth becomes typography inside the field — a sub-heading,
  or a breadcrumb once indentation stops being readable.
- Groups that hide their healthy children render as their own status rather than "no services
  available" — which is what an unaware renderer would have shown for four of the six groups on
  status.emeraldhost.de. The bot states a count only when the statuspage itself would (i.e.
  when something is affected), so it never discloses a fleet size the operator keeps off their
  own page.
- Cloud incidents, maintenance windows and standing advisories arrive as three separate concepts
  and are rendered as one alert stream. An advisory is never coloured like an outage and never
  pings a role: it carries no severity at all, so that cannot be got wrong.
- Alert bodies are Markdown on the Cloud and HTML on self-hosted; `util/markdown.js` handles
  both. Discord speaks Markdown, so the Cloud path mostly removes what Discord cannot render
  (images, tables, rules, stray HTML).
- Protected Cloud pages are rejected at subscribe time with an explanation, rather than
  producing a subscription that silently never posts.
- New modules: `dto/statuspage.js`, `providers/`, `api/detect.js`, `api/livckCloud.js`,
  `util/errors.js`, `util/logger.js`, `util/discordLimits.js`, `util/messageSync.js`,
  `util/markdown.js`, `util/subscriptionGroups.js`.
- Golden-output snapshot tests pinning every layout, so a refactor cannot silently change what
  customers see. Contract tests run against a stubbed `fetch`; live checks against
  `cloud.statuspage.de` and `status.livck.com` are opt-in via `LIVCK_LIVE_TESTS=1`, so a
  third-party outage no longer fails CI.

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
- `/livck resume` always reported the pause reason as "unknown", because it read the field after
  clearing it.

### Changed

- **Status messages are only edited when they actually change.** Each `Message` stores a hash of
  its last payload. Combined with dropping the redundant `channel.messages.fetch()` before every
  edit, this removes almost all Discord API traffic in steady state — the bot previously spent
  two calls per subscription per cycle against a 50 req/s account-wide budget, which capped it
  near 375 subscriptions. A heartbeat edit still refreshes the timestamp every
  `STATUS_REFRESH_MINUTES` (default 15).
- **Pausing is now a backoff ladder** (30s → 1m → 5m → 15m → 1h → 6h) instead of a dead end.
  Subscribers are notified once, roughly 22 minutes into a sustained outage, and the page resumes
  by itself — with a recovery notice — as soon as it answers again. A dead domain drops from 5760
  attempts a day to nine. `/livck resume` still forces an immediate retry.
- Pause and resume notifications are sent in each subscription's own language instead of one
  bilingual embed.
- Everything downstream of a fetch reads one internal model (`dto/statuspage.js`) rather than a
  backend-specific payload. The self-hosted rendering is unchanged — 21 golden snapshots prove
  it byte for byte.
- `handleStatusPage` and `handleAlerts` share one fetch per cycle instead of each making their
  own, which also removes a redundant alerts request self-hosted pages were already paying.
- `Statuspage.pauseReason` is a `VARCHAR(32)` rather than an `ENUM`, and covers the full failure
  vocabulary (`TIMEOUT`, `DNS`, `REFUSED`, `TLS`, `HTTP_4XX`, `HTTP_5XX`, `RATE_LIMITED`,
  `NOT_LIVCK`, `NETWORK`, `UNKNOWN`).
- **Logging is leveled** via `LOG_LEVEL` (default `info`). Per-statuspage chatter moved to
  `debug`, leaving one summary line per cycle. Expected network failures log a single line with
  no stack trace, and repeats for the same page are suppressed until the message changes — a
  dead domain went from ~5760 log entries a day to roughly ten.
- Discord rate limiting is now reported through a `rateLimited` listener; previously discord.js
  queued silently and the only symptom was updates arriving later and later.

### Removed

- `messages/messageHelper.js` — nothing had imported it for some time, and it referenced the old
  status vocabulary, so it was both dead and wrong.

### Migration required

```bash
node migrate.js
```

Adds `Messages.contentHash`, `Statuspages.backoffLevel`, `Statuspages.nextAttemptAt`,
`Statuspages.kind`, `Statuspages.externalId` and `Statuspages.detectedAt`, and converts
`Statuspages.pauseReason` from `ENUM` to `VARCHAR(32)`. Existing rows need no backfill — a page
with `kind = NULL` is detected on its first cycle after deploy.

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
