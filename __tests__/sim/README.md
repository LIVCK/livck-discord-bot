# The simulation

The real bot process — `node server.js`, migrations, discord.js, Sequelize, Redis, shutdown —
against a simulated Discord and simulated LIVCK status pages. Everything the bot decides (when,
what, where, how often, in which order) runs exactly as in production; only the two things it
talks to are replaced, and both know at every moment what the bot should have done.

```bash
docker run -d --name livck-sim-db -p 3306:3306 -e MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=1 mariadb:11
docker run -d --name livck-sim-redis -p 6379:6379 redis:7

npm run test:sim                                    # everything
npm run test:sim -- __tests__/sim/faults.sim.test.js
SIM_VERBOSE=1 npm run test:sim -- -t "kicked"       # with the bot's own log
```

Each scenario creates a database of its own (`livck_sim_<random>`) and drops it again, and only
ever touches Redis keys starting with `dc-bot:`. `SIM_DB_HOST/PORT/USER/PASSWORD` and
`SIM_REDIS_HOST/PORT/PASSWORD` point it elsewhere (defaults: `127.0.0.1`, root, no password).

## What is in it

| | |
|---|---|
| `harness/discord.js` | Discord: REST, the gateway (READY, GUILD_CREATE/DELETE, CHANNEL_UPDATE, interactions), guilds the bot is in or was thrown out of, channels it may or may not see, Discord's rate limits and nonce deduplication — and **the referee** |
| `harness/pages.js` | LIVCK Cloud status pages whose state a scenario changes: components, incidents that open, develop, resolve, get corrected or taken down |
| `harness/oracle.js` | **The oracle**: what every channel must contain, worked out from the world |
| `harness/bot.js` | Starts the bot (this checkout or another one) with every variable set explicitly; `preload.cjs` points discord.js at the simulation and keeps the developer's `.env` out |
| `harness/world.js` | Ties it together: `converge()`, `quiet()`, `clean()` |

## The three questions every scenario asks

**converge** — do the channels look exactly as the world says they must? Every subscription has
one status message, and it is what the real renderer makes of the page *now*. Every incident
that started after the subscription has one announcement and one reply per later update, in
order, each with that update's text. An incident taken off the page has nothing left. Nothing
else is in the channel.

**quiet** — with nothing changing, the bot sends Discord nothing at all.

**clean** — the referee saw no broken rule, on any request, at any time:

| rule | |
|---|---|
| `duplicate` | a message whose content is already in that channel |
| `reply-orphan` | a reply to a message that is not there |
| `noop-edit` | an edit that changes nothing — unless the bot never learned its last write arrived |
| `not-a-member` | a request to a guild the bot is not in |
| `limits` | a message Discord would reject for its size |
| `unknown-route` | an endpoint the bot was never meant to call |
| `burst` | running into Discord's global limit again and again |

`harness.test.js` makes each rule and each oracle check catch a mistake committed on purpose. It
needs no database and runs in the ordinary `npm test`.

## The scenarios

| file | |
|---|---|
| `lifecycle.sim.test.js` | Several guilds, pages, all five layouts, both languages; incidents from first post to resolution, a corrected update, a page that hides its history, an incident taken down |
| `membership.sim.test.js` | Kicked live, kicked while offline, a guild outage, a hidden / read-only / deleted channel — what happens to the subscription and how often the bot asks |
| `faults.sim.test.js` | Every network fault at once on some channels; a deploy mid-burst; SIGKILL between Discord making a message and the bot recording it; the gateway dropping |
| `subscribe.sim.test.js` | `/livck subscribe` through the gateway: command, modal, submit — discord.js's own parsing of what Discord sends |
| `load.sim.test.js` | 150 subscriptions (`SIM_SCALE` multiplies): a restart with every status due, then an outage on every page; incidents must arrive before status edits |
| `rollout.sim.test.js` | The deployed version builds a state; the new one must touch **nothing** on its first cycles, then carry on in threads it did not open. Needs `SIM_BASELINE_DIR` (a checkout with dependencies installed) |
| `chaos.sim.test.js` | A seeded random walk through all of the above. `SIM_SEED` replays a run exactly; `SIM_CHAOS_RUNS`, `SIM_CHAOS_STEPS` turn it up; `SIM_SEEDS=regression` runs the seeds that once found a real fault |

## In CI

`.github/workflows/simulation.yml` runs every scenario on each pull request, with the chaos
**regression seeds** rather than new ones — a pull request is judged on what it changes, not on a
new seed finding something unrelated. The nightly run hunts with ten new seeds and four times
the load on top. A seed it turns red goes into `REGRESSION_SEEDS` once its fault is fixed.

The image build (`.github/workflows/build.yml`) runs the tests and the simulation first and
publishes nothing unless both pass; it then builds the image and simulates THAT image — its own
entrypoint and migrations — before pushing it. `SIM_BOT_IMAGE=<image>` does the same locally:

```bash
docker build -f docker/Dockerfile -t livck-bot:local .
SIM_BOT_IMAGE=livck-bot:local npm run test:sim -- __tests__/sim/lifecycle.sim.test.js
```

The rollout starts from the pull request's base branch, or from the repository variable
`SIM_BASELINE_REF` when that is set — set it to whatever production actually runs. When a
scenario fails, every bot's full log is uploaded as the `sim-logs` artifact (`SIM_LOG_DIR`).

## What it does not prove

That the *real* Discord accepts what the bot sends — that stays with
`__tests__/e2e/discord.live.test.js` and a real test bot. And how the modal looks in a client.

## When it fails

The message says which scenario, which channel, what was expected and what was there, every
broken rule with the request that broke it, and the last lines of the bot's log. A chaos failure
starts with `SIM_SEED=…` and the list of steps it took; run it again with that seed.
