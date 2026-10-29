# Ampli World

A tiny town on the intranet where an AI character lives its own life. **Ampli**, a small fox, gets hungry, tired and bored, decides for itself what to do about it, reads books in the library, and writes a diary every night. Colleagues can watch, and see exactly how it works.

It's a door-opener: people get used to AI by watching an agent behave instead of being asked to prompt one. Inspired by [Pino](https://pinos.world/).

## Quickstart

```bash
npm install
cp .env.example .env      # add OPENROUTER_API_KEY (optional, see below)
npm run dev               # sim :4300, brain, web :5173
```

Open http://localhost:5173.

By default a sim day lasts 4 real hours. While developing, set `SIM_MINUTES_PER_SECOND=1` in `.env` to see a whole day in 24 minutes.

Without an `OPENROUTER_API_KEY`, the brain runs **offline**: simple rules and scoring, canned thoughts, no LLM calls. That's enough to work on the world and the UI.

Requires Node ≥ 22.13 (uses the built-in `node:sqlite`; Node prints an `ExperimentalWarning` for it, which is harmless).

## How it works

```
apps/sim  (source of truth)      apps/brain  (worker)                apps/web  (viewer)
- clock, places, needs, mood     - polls /api/brain/context          - SSE /api/stream
- runs actions, walks paths      - rules → LLM → offline fallback    - canvas town + glass-box panel
- SQLite: events, diary,   ◀──── - POST decision / reading / diary   - can't change anything
  notebook, LLM spend            - OpenRouter via forced tool calls
```

Three processes, on purpose (same split as Pino):

- **sim** owns the world. It ticks once per second, drains needs, moves the character along roads, finishes activities and logs every event. It runs whether or not a brain or browser is connected.
- **brain** has no state of its own. When the character is idle it decides what to do next:
  1. **Routine rules** (no AI): bed at night, nap when exhausted, food when starving.
  2. **LLM** for everything else: gets persona, needs (in words), mood, notebook, last diary entry, recent events, options and the library catalogue, then answers through a `decide` tool call with an activity plus a thought. The thought is what the feed shows.
  3. **Offline** fallback (utility scoring) with no key, when over budget, or if a call fails.
- **web** is a pure renderer: it interpolates movement between ticks and shows the thoughts, diary, notebook and a "How it works" tab with today's spend.

**Memory** is just text: the event log, a nightly diary, and a notebook of at most 12 notes that the character rewrites every night (the `REFLECT_MODEL` call). That rewrite is the only long-term memory, so forgetting is part of the design.

**Reading is real**: when Ampli reads, the model gets the full book text from `world/library/` and writes a takeaway, which feeds into that night's notebook rewrite.

**Doodles and the art studio**: letters can carry a doodle drawn in the browser. The model really looks at it, both for the check and when replying, and writes a short caption that can reach the diary. In the studio, Ampli paints by writing SVG (shapes and colours as code, no image generator). The sim rejects any SVG with scripts, event handlers or external references and serves SVGs with a `default-src 'none'` CSP. The newest painting stands on the easel; all of them are in the Art tab.

**The internet café is real too**: Ampli picks something it wants to look up (often prompted by a book or a letter). The query is checked by the moderation model before it appears anywhere. OpenRouter's web plugin then returns 3 pages, and the model writes a short note. The feed shows the query, the note (checked again) and the source links. Web pages are treated as information only: the search call has no tools, and only http(s) links reach the page.

## Making it yours

| What | Where |
|---|---|
| Character: name, species, personality, voice | `world/persona.md` (frontmatter + system prompt) |
| Library books | `world/library/*.md` with `title`, `author`, `blurb` frontmatter; restart the sim |
| Places, activities, need rates, map | `packages/shared/src/world.ts` |
| Prompts | `apps/brain/src/prompts.ts` |
| Drawing | `apps/web/src/town.ts` |

## Configuration (`.env`)

| Variable | Default | Notes |
|---|---|---|
| `OPENROUTER_API_KEY` | – | Empty = offline mode |
| `BRAIN_MODEL` | `anthropic/claude-haiku-5.5` | Frequent decisions and book takeaways |
| `REFLECT_MODEL` | `anthropic/claude-sonnet-5.5` | Nightly diary + notebook rewrite |
| `LLM_REASONING` | `off` | Hidden thinking for reasoning models (`off`/`low`/`medium`/`high`). Some models, e.g. DeepSeek V4.1 Flash, think by default, which costs more and can cut off the tool call |
| `WEB_SEARCH` | `on` | Internet café: real web searches through OpenRouter's web plugin (Exa engine). `off` closes the café |
| `WEB_SEARCHES_PER_DAY` | `20` | Daily cap (UTC). Each search costs about $0.0075, so the default cap is at most ~$0.15/day |
| `WEB_EXCLUDE_DOMAINS` | – | Comma-separated domains Ampli never gets results from (`reddit.com,*.example.com`) |
| `ART_PER_DAY` | `10` | Artworks per day (UTC) in the art studio, made with `REFLECT_MODEL` |
| `LLM_DAILY_BUDGET_USD` | `2` | Hard cap per UTC day, then offline. Uses OpenRouter's reported `usage.cost` |
| `LLM_MAX_CALLS_PER_HOUR` | `120` | Guards against runaway loops |
| `SIM_MINUTES_PER_SECOND` | `0.1` | 0.1 = a sim day lasts 4 real hours. `1` = 24 minutes (handy while developing). `0.0166667` = real time |
| `SIM_PORT` / `SIM_URL` | `4300` | |
| `BRAIN_TOKEN` | `change-me` | Shared secret for `/api/brain/*` |
| `ADMIN_TOKEN` | – | Enables `/admin`: held letters and replies, reports, mailbox kill switch. Empty = admin off |
| `SITE_PASSWORD` | – | One shared password for the whole site (browser login prompt). Brain endpoints are unaffected |

**Rough cost:** cost scales with sim days per real day, because the model is called per activity (about 10 decisions, 1–2 book notes and 1 diary per sim day). The defaults (Haiku 5.5 + Sonnet 5.5 at speed 0.1, i.e. 6 sim days per real day) come to about **$2–3 per month**. Speed 1 costs about 10× that. Each thought in the UI shows its actual cost.

| Tier | `BRAIN_MODEL` | `REFLECT_MODEL` | ≈ $/month at speed 0.1 |
|---|---|---|---|
| Cheapest | `deepseek/deepseek-v4.1-flash` | same | $0.30 (untested with forced tool calls; pin a provider) |
| Balanced (default) | `anthropic/claude-haiku-5.5` | `anthropic/claude-sonnet-5.5` | $2.30 |
| High-end | `anthropic/claude-opus-5.5` | same | $22 |

Prices are OpenRouter list prices as of October 2026.

## Production

```bash
npm run build   # builds apps/web/dist; the sim serves it
npm start       # sim + brain
```

## Before sharing beyond your machine

- Without `SITE_PASSWORD` the site has **no auth**. Set it, or keep the sim behind SSO/VPN, before you share the URL. The sim listens on all interfaces.
- Set a real `BRAIN_TOKEN`. Anyone holding it can steer the character.
- The mailbox puts **untrusted text into an LLM**. Letters are checked by a model before they reach the post box, each reply is an isolated call with one tool, and public replies are checked again before publishing. Held items, reports (3 take a letter down) and the kill switch are on `/admin`.

## Development

```bash
npm test         # node:test via tsx: engine, store, routine rules, prompts
npm run typecheck
```

## Roadmap

1. ~~Town, needs + mood, routine/LLM brain, diary + notebook, live thought feed~~ (this MVP)
2. Mailbox ([design](docs/mailbox.md)): ~~letters, moderation, post box, replies, notice board~~, ~~visitor memory + forget-me + 90-day expiry~~, ~~admin view, reports, kill switch, site password, per-IP limit~~, ~~doodle pad~~
3. ~~Internet café (real web search)~~; ~~art studio (SVG paintings, gallery, easel)~~
4. Workshop: writes small programs in a sandbox and publishes them in town; daily diary post to Slack/Teams
5. ~~Building interiors (roofs fade when Ampli is inside or on hover)~~, a small economy, town events
