# Mailbox (phase 2): design

Colleagues leave Ampli a note or a doodle. Ampli reads it in its own time, replies and remembers them.

## Decisions

### Decided with Dennis
| Topic | Decision |
|---|---|
| Identity | Self-typed name. No login for now |
| Visitor memory | Tied to a random visitor ID in an httpOnly cookie; the name is display only. New browser = new visitor |
| Visibility | Per note: **public (default)** or private. Ampli never mentions what it remembers about a visitor in public. The form says admins can read private notes |
| Content | Text (≤ 500 chars) plus a **doodle pad** (drawn in-browser, small PNG). No file uploads |
| When Ampli reads | Post box at the plaza, new `check_mail` activity. The brain sees "N letters waiting" and decides freely; a routine rule forces a check once the oldest letter has waited 3 sim hours. Asleep at night, so letters wait until morning and the form says so |
| Replies | One isolated LLM call per letter with `REFLECT_MODEL`: persona, mood, notebook, this letter and this visitor's memory only. Ampli may decline to reply, in which case the sender sees "read" |
| Letters → public life | Public letters (with name) become events that thoughts, diary and notebook can use. Private letters leave only "read a private letter": content never reaches those prompts (structural, not prompt-based) |
| Retention | "Forget me" button (deletes letters, replies and visitor memory; name → "a visitor" in diary/notebook) plus auto-expiry 90 days after last visit. Privacy notice on the form. Check with the data protection officer / works council before launch |
| Moderation | Check before publishing: every letter/doodle on the way in, and public replies and diary entries on the way out. Held items go to an admin view. Report button, kill switch (details below) |

### Decided by default (veto if you disagree)
| Topic | Decision |
|---|---|
| Reachability | Still open. Ships with an optional `SITE_PASSWORD` (built-in basic auth). Launch rule: VPN/office network **or** password, never the open internet without either |
| Moderation | A cheap model call (`BRAIN_MODEL`) checks every letter and doodle (*ok / hold*) **before** it reaches the post box, and checks Ampli's public replies and diary entries before they're published. Held items go to an admin view; the sender sees "waiting for review". A report button on every public item. Admin kill switch pauses the mailbox |
| Prompt injection | Letters go inside `<letter>` tags and are declared untrusted. The reply call has exactly one tool (`reply`) and can't change the world. Isolation per letter limits damage to that one reply and that visitor's own memory. Output limits: reply ≤ 600 chars, memory ≤ 300 chars. Outbound moderation is the backstop |
| Rate limits | Per visitor: 3 letters/hour, 10/day. Per IP: 20/day (catches cookie-clearers). Max 5 letters read per post-box visit. Post box holds 50, after which the form says "full, try later" |
| Over budget / no key | Letters wait. No canned offline replies, since fake answers would undermine trust. The UI says "Ampli is resting its head" |
| Admin | `ADMIN_TOKEN` in `.env`, a simple admin view: held items, reports, hide/unhide, kill switch |

## Cost
Per letter: inbound check + reply + outbound check.
- DeepSeek V4.1 Flash: ~$0.0004 per letter → 50 letters/day ≈ **$0.60/month**
- Sonnet 5.5 for replies: ~$0.007 per letter → 50 letters/day ≈ **$10/month**

## Fit with sim / brain / web
- **sim** (still the only state owner, still no LLM calls)
  - Tables: `visitors` (id, name, memory, first/last seen), `letters` (visitor, text, doodle, visibility, status, reply, timestamps), `reports`
  - Letter status: `checking → held | waiting → read | replied | skipped → hidden`
  - Public: `POST /api/mail` (sets the visitor cookie), `GET /api/mail/mine`, `GET /api/board`, `POST /api/mail/:id/report`, `POST /api/forget-me`
  - Brain: `GET /api/brain/mail/pending-checks`, `POST /api/brain/mail/:id/verdict`, `GET /api/brain/mail/waiting` (with that visitor's memory), `POST /api/brain/mail/:id/reply`
  - Admin: `/api/admin/*` behind `ADMIN_TOKEN`
  - New activity `check_mail` at the plaza; events `mail_read` (public: name + excerpts; private: no content)
  - Daily expiry sweep; optional `SITE_PASSWORD`
- **brain**: moderation queue worker, `check_mail` in decisions plus the 3-sim-hour routine rule, the reply call per letter, outbound check before posting
- **web**: "Mailbox" tab (form with name remembered locally, private checkbox, doodle pad, privacy notice), "My letters" (status + replies), public board, report + forget-me buttons; post box sprite on the map with a letter icon when mail is waiting; admin page

## Build order
1. ✅ Text letters end-to-end: form → check → post box → `check_mail` → reply → board / my letters (incl. per-visitor rate limits and post-box capacity; per-IP limits come with step 4). Tested live with DeepSeek V4.1 Flash: an injection attempt and an insult with a phone number were both held, and a private German letter got a private German reply
2. ✅ Visitor memory, forget-me, 90-day expiry, privacy notice. Memory has two scopes (public letters / private letters), and public replies only ever see the public one. "What Ampli remembers about you" is shown in the Mail tab. Forget-me deletes letters, the visitor, their `mail_read` events, and replaces their name (case-sensitive, whole word) with "a visitor" in thoughts, readings, diary and notebook history. Brain logs never contain private letter content, because logs aren't covered by forget-me. Tested live: a public reply after a private worry didn't mention the worry; forget-me left zero mentions
3. ✅ Doodle pad: 256×256 PNG (≤ 48 KB, signature and size checked in the sim), doodle-only letters allowed, image passed to the moderation call and to the reply call. Ampli writes a `doodleCaption` that reaches public events (and so the diary). Served from `/api/mail/:id/doodle` with the letter's visibility rules. Tested live: Ampli counted the 12 rays on a test sun correctly and later painted its own version
4. ✅ Admin view (`/admin`, `ADMIN_TOKEN`), report button (3 distinct reporters → held), kill switch (paused mailbox looks empty to the brain), `SITE_PASSWORD` (basic auth, brain endpoints excluded), per-IP limit 20/day (salted IP hash, salt changes on restart, deleted with the letter). Held web notes from the internet café are dropped, not stored, so there's nothing to review there
