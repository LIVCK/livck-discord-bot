# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

LIVCK Cloud support, plus the groundwork it needed — several fixes that affect self-hosted
status pages just as much.

### Added

- **A simulation of production in CI.** The real bot process runs against a simulated Discord
  (REST and gateway) and simulated status pages, with a real database and Redis. A referee
  checks every request the bot makes, and the expected contents of every channel are worked
  out from the simulated world and compared — through incidents, kicks, permission changes,
  network faults, crashes, load, a rollout from the deployed version and seeded chaos. See
  `__tests__/sim/README.md`. `REDIS_DB` selects a Redis database other than 0.
- **LIVCK Cloud status pages.** Which product a page runs is detected from response headers on
  first contact and stored, so `/livck subscribe` is unchanged for customers: paste a URL, done.
- **Threads are finished when their alert ends.** The Cloud drops an incident from
  `active_incidents` the moment it resolves, so a Discord thread used to keep "we are
  monitoring" for ever. The closing update is now fetched from the detail endpoint and posted
  as one more reply. Needs no backend change — the endpoints already exist. When the page
  will not confirm the ending (`show_incident_history` off → 404) the thread is left on its
  last legitimate state rather than being given an invented one, and it is never re-queried
  beyond the reporting window.
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

- **One bad link emoji no longer stops a channel's status message.** Discord rejects a whole
  message over one button emoji it does not accept, and the custom link modal took any text, so
  a word or an emoji with text after it froze that channel's status for as long as the link
  existed. The modal now accepts one emoji or a server emoji (`<:name:id>`) and says so
  otherwise; an emoji already saved that does not qualify is left off the button; and should
  Discord refuse one anyway, the status goes out without link emojis instead of not at all.
- **An alert taken off the page takes even a message the bot never got the id of.** Posted with
  the answer lost, then taken down before a retry learned the id, the announcement used to stay.
  The bot now finds its own messages among the channel's recent ones by the alert's link.
- **An announcement is never left without its ending after a crash.** The row that remembers a
  message is written before the message is sent, marked pending, and confirmed after. A bot
  killed in between used to leave an announcement no later process knew about; when its incident
  resolved before the restart, the thread said "investigating" for good. A message recovered
  that way is checked against what it should show, and edited if Discord handed back an older
  version of it, and posted under a fresh nonce if it was deleted meanwhile (Discord answers a
  nonce whose message is gone with 10008 instead of posting).
- **A lost answer to an edit can no longer leave a message showing the wrong state.** The stored
  content hash is forgotten before each edit and written again once Discord confirms, so a page
  that changed and then changed back is not mistaken for unchanged.
- **A status page on its own port can be subscribed.** The URL was normalised to its host
  name alone, so `https://status.example.com:8443` was saved — and polled — without the port.
- **A message is not posted twice when the bot dies right after posting it.** Killed between
  Discord making a message and the bot recording it, the next process posted it again. The
  first nonce of every message is now derived from what the message is, so any process that
  tries to post it asks Discord for the same one; a message being reposted on purpose (an
  admin deleted it) still gets a fresh nonce.
- **A refused request reached the bot without Discord's error code.** The refused-request
  summary read the response body to name the code, but discord.js hands its listeners the body
  it is about to read itself; every 401/403/429 then failed with an internal assertion instead
  of `Missing Access` or `Missing Permissions`, so a channel the bot could not see was never
  recognised as one. The summary names status and route only now.
- **A channel the bot can no longer see keeps its subscription.** Missing Access (50001) deleted
  the subscription as if the channel were gone, so making a category private for a moment, or
  editing the bot's role, cost a guild its whole setup. The channel now backs off — 1 minute
  up to 6 hours — and any channel or role change in that guild, or any `/livck` there, lets it
  try again at once (read from the gateway itself: discord.js reports no change for a channel it
  could not see, which is the one that matters). Only a deleted channel (10003) still removes a subscription.
- **A bot removed from a server stops asking it.** Kicked while running, the server's
  subscriptions are deleted the moment Discord reports it; an outage, which Discord reports
  differently, deletes nothing. Kicked while offline, the server is missing from the list
  Discord sends at login (or on reconnecting, where discord.js itself would have kept believing
  in it), and its subscriptions are skipped — no request at all — but kept,
  because a bot holding the wrong token sees the same and must not delete on it. Invited back,
  they resume by themselves.
- **One channel could stop the bot for everyone.** A cycle waited for its slowest page before
  the next one was scheduled, and inside a page every channel waited for the one before it.
  discord.js retries a 429 without limit (and without emitting `rateLimited`), so a single
  rate-limited or silent channel held every status page for as long as Discord kept refusing
  it — in production twenty to fifty minutes at a time, which is why an incident could take
  ten minutes to reach a channel while the log showed nothing but INVALID REQUEST warnings.
  Now every delivery has its own deadline, the channels of a page are delivered concurrently,
  a page still running is skipped instead of awaited, and a 429 Discord actually sends is
  final instead of retried for ever.
- **A channel the bot may not post in was asked again every 15 seconds**, for ever, each
  refusal counting towards Discord's IP ban. A failing channel now backs off on its own
  (30s up to 10 minutes) without affecting its page; the first success or any `/livck` in
  that guild clears it.
- The subscription removal brake let more through than its limit once deliveries ran in
  parallel (measured: 30 removed with a limit of 25). Asking and counting is one step now.
- **A shutdown closed the database under the cycle still running.** The loop stopped
  scheduling and the connections were closed in the same breath, so a message sent in that
  moment had no row and was posted again by the next process. Shutdown now waits for the
  cycle and for deliveries that outlived it, bounded by `SHUTDOWN_DEADLINE_MS`.
- A database outage printed some forty lines of stack trace every 15 seconds. It is one line
  per outage now, and one when the database is back.
- `DB_PORT` and `DB_DIALECT` were honoured by `migrate.js` but ignored by the bot itself, so
  a database outside port 3306 was migrated and then never reached.
- **In a burst every channel was reported as not answering, and alerts came last.** Discord
  takes 50 requests per second and discord.js queues the rest, with each delivery's deadline
  running in that queue. The first cycle after a restart, with every heartbeat due, sent them
  all in together: each one overran, each channel was logged as silent, and an incident alert
  stood behind every status edit. At most 25 deliveries (`DISCORD_DELIVERY_SLOTS`) are now with
  discord.js at a time, the deadline starts when a delivery gets its slot, and alerts go first.
- **A lost gateway went unnoticed.** Status updates go over REST and kept arriving, while
  slash commands, which only come over the gateway, were silently no longer answered. After a
  close discord.js does not recover from (a reset token, an intent not enabled) or ten minutes
  without a connection (`GATEWAY_STALL_MINUTES`), the bot now shuts down cleanly with exit code
  1 for its supervisor to restart. A drop lasting more than 30 seconds is logged once, and so is
  its end; the routine reconnects Discord asks for say nothing.
- **A message could be posted several times when Discord's answer got lost.** A POST that
  reaches Discord but whose answer does not — a network blip on the way back, or Discord
  answering slower than the client's 15 seconds — was sent again by discord.js, up to three
  times, and once more by the delivery's backoff later. Against the real API with the answers
  dropped: six copies of one incident, one of them recorded. Every new message now carries a
  nonce with `enforce_nonce`, kept from its first attempt until its row is written, so Discord
  returns the message it already made instead of making another.
- A message Discord accepted while its row could not be written (database gone at the wrong
  moment) is taken back, instead of being posted a second time on the next cycle.
- A shutdown could let a page that overran its deadline start a delivery after the drain had
  begun, which is the post-without-a-row the drain exists to prevent. Deliveries asked for once
  the drain has started are not started.
- A failed delivery after a 429 logged an empty reason (`(RateLimitError[…]): , next attempt`).
- Waits discord.js sits out by itself were logged one line each, so a heartbeat across a
  few hundred channels wrote a few hundred lines. They are counted per route now and appear
  in the once-a-minute Discord summary, next to the refused requests.
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

- **The Docker image is only published from code that passed.** `latest` used to be pushed on
  every push to `main`, whatever the tests said, a closed pull request published an image
  tagged `merge`, and release tags built none. Now the tests and the simulation run first, the
  image is built and simulated itself, and only then pushed — `latest` from `main`, `1.2.3` and
  `1.2` from a release tag. Pull requests build and simulate the image without pushing it.
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
- The Discord channel is resolved only when a message is actually going to be sent. discord.js
  serves it from the gateway cache in steady state, but that cache is cold right after a
  restart — resolving it eagerly meant one REST call per subscription in the very first cycle,
  which is when the bot can least afford them.
- `Statuspage.pauseReason` is a `VARCHAR(32)` rather than an `ENUM`, and covers the full failure
  vocabulary (`TIMEOUT`, `DNS`, `REFUSED`, `TLS`, `HTTP_4XX`, `HTTP_5XX`, `RATE_LIMITED`,
  `NOT_LIVCK`, `NETWORK`, `UNKNOWN`).
- **Logging is leveled** via `LOG_LEVEL` (default `info`). Per-statuspage chatter moved to
  `debug`, leaving one summary line per cycle. Expected network failures log a single line with
  no stack trace, and repeats for the same page are suppressed until the message changes — a
  dead domain went from ~5760 log entries a day to roughly ten.
- **discord.js 14.28.1** (from 14.22.1). It reads the Type 18 Label components of the subscribe
  modal itself, so `scripts/patch-discordjs.js` and the `postinstall` step that rewrote two of
  its files are gone, and with them the pin to one exact version of its source. The startup
  check in `util/modalSupport.js` stays and refuses a discord.js that cannot read the modal.
  Replies use `flags: MessageFlags.Ephemeral` and the login line listens for `clientReady`:
  `ephemeral` and `ready` print deprecation warnings in 14 and do nothing in 15.
- Discord rate limiting is now reported: waits per route, and refused requests per route and
  Discord error code, in one line per minute. Previously discord.js queued silently and the
  only symptom was updates arriving later and later.

### Security

- **Component and modal interactions did not check guild ownership.** Twenty-nine lookups
  resolved a subscription, custom link or role mention straight from the id carried in a
  `custom_id` — a value the bot put there, not a claim to act on unchecked. `delete_sub_`
  destroyed a subscription and `edit_api_token_` read and wrote a status page API token that
  way. Every id-driven path is now scoped to `interaction.guildId`, matching what the
  slash-command paths already did.
- undici is 6.29 through discord.js 14.28, which closes the two advisories against the version
  14.22 shipped (unbounded decompression of a response, and a WebSocket frame length that
  crashes the parser).
- Discord's `invalidRequestWarning` is now armed (`invalidRequestWarningInterval: 250`). It was
  disabled by default, and it is the only advance warning before Discord blocks a bot's IP at
  the Cloudflare layer for accumulating 401/403/429 responses — which the bot produces whenever
  a channel is deleted or its permissions are withdrawn.

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
