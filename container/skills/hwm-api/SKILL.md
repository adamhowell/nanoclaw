---
name: hwm-api
description: Access Adam's email, todos, calendar, orders, notes, contacts, weather, briefings, and voice calls via the HWM API, plus every number about the business (sales and revenue for any dates, by shop, compared with the span before; the books; ads; site traffic). Use when the user asks about any of these. Sales, revenue and trend questions start here, never on Etsy's screen.
---

# HWM API — Personal Data Access

You can access Adam's personal data through the HWM API using `curl`.

## Authentication

```bash
curl -s -H "Authorization: Bearer $HWM_API_TOKEN" "$HWM_API_URL/endpoint"
```

Environment variables `HWM_API_URL` and `HWM_API_TOKEN` are pre-configured.

---

## Email

### List unread emails
```bash
curl -s -H "Authorization: Bearer $HWM_API_TOKEN" "$HWM_API_URL/emails/unread?limit=10"
```

### Search emails
```bash
curl -s -H "Authorization: Bearer $HWM_API_TOKEN" "$HWM_API_URL/emails/search?query=TERM&folder=inbox&limit=10"
```
Folder: `inbox`, `sent`, `archived`, `all`

### Read single email (full body)
```bash
curl -s -H "Authorization: Bearer $HWM_API_TOKEN" "$HWM_API_URL/emails/EMAIL_ID"
```

### Read full email thread
```bash
curl -s -H "Authorization: Bearer $HWM_API_TOKEN" "$HWM_API_URL/emails/EMAIL_ID/thread"
```

### Send reply
```bash
curl -s -X POST -H "Authorization: Bearer $HWM_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"body":"Reply text","archive":true}' \
  "$HWM_API_URL/emails/EMAIL_ID/reply"
```
**NEVER send without showing the user a draft first and getting explicit confirmation.**

### Archive email/thread
```bash
curl -s -X POST -H "Authorization: Bearer $HWM_API_TOKEN" \
  -d '{"whole_thread":true}' "$HWM_API_URL/emails/EMAIL_ID/archive"
```

### Snooze email
```bash
curl -s -X POST -H "Authorization: Bearer $HWM_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"snooze_until":"2026-03-29T09:00:00"}' \
  "$HWM_API_URL/emails/EMAIL_ID/snooze"
```

### Trigger email sync from Fastmail
```bash
curl -s -X POST -H "Authorization: Bearer $HWM_API_TOKEN" "$HWM_API_URL/emails/sync"
```

---

## Todos

### List todos by category
```bash
curl -s -H "Authorization: Bearer $HWM_API_TOKEN" "$HWM_API_URL/todos?list=LIST&limit=50"
```
List options: `today`, `tonight`, `this_week`, `this_weekend`, `upcoming`, `anytime`, `someday`, `overdue`

### List completed todos
```bash
curl -s -H "Authorization: Bearer $HWM_API_TOKEN" "$HWM_API_URL/todos/completed?range=RANGE"
```
Range: `today`, `yesterday`, `this_week` (default: last 7 days)

---

## Calendar

### Get calendar events
```bash
curl -s -H "Authorization: Bearer $HWM_API_TOKEN" "$HWM_API_URL/calendar?range=RANGE&limit=20"
```
Range: `today`, `tomorrow`, `week` (default: all upcoming)

---

## Sales and orders (Etsy and theachievemint.com)

Any sales question ("are we up", "last 90 days against the 90 before", "how
is the site doing") is ONE call. Do not guess other URLs, and do not open
Etsy Shop Manager for numbers: hwm_app has every Etsy and site order off the
sale emails, back to the start.

```bash
curl -s -X POST -H "Authorization: Bearer $HWM_API_TOKEN" -H "Content-Type: application/json" \
  "$HWM_API_URL/tools/orders" -d '{"from":"2026-08-18","to":"2026-11-16"}'
```

Returns `orders`, `revenue`, `by_source` (order counts) and
`revenue_by_source` (dollars) for those dates, and a `before` block with the
same four for the equal span just before. Dates are whole Eastern days,
inclusive. `{"days":7}` works in place of from/to (no `before` block).

- Sources are `etsy`, `achievemint` (the website, there is no separate
  "website" source) and `amazon`.
- Amazon is discontinued and Adam never wants it mentioned, not even to say
  it was left out. Leave it out silently. The plain
  `orders` and `revenue` totals still include old Amazon orders, so build
  every total and every comparison from the etsy and achievemint lines of
  `by_source` and `revenue_by_source`.
- For a trend, make two or three calls with different windows (last 30,
  31 to 90, 91 to 180) and compare dollars per day.

Individual orders: `POST $HWM_API_URL/tools/search_orders`, or the older
`GET $HWM_API_URL/orders?days=7&limit=25`.

---

## Every other number: the tools list

hwm_app and theachievemint.com each publish their read tools at one address.
These are the same tools Adam's Claude uses, so the list is always current
even when this file is not. **Before telling Adam something can't be looked
up, list the tools.** Two 404s on guessed URLs means stop guessing and list.

```bash
# What exists (name, what it does, arguments)
curl -s -H "Authorization: Bearer $HWM_API_TOKEN" "$HWM_API_URL/tools" \
  | python3 -c "import json,sys; [print(t['name'], '|', t['about'], '|', ', '.join(t.get('args',{}))) for t in json.load(sys.stdin)['tools']]"
curl -s -H "Authorization: Bearer $TAM_API_TOKEN" "https://theachievemint.com/api/v1/tools" \
  | python3 -c "import json,sys; [print(t['name'], '|', t['about'], '|', ', '.join(t.get('args',{}))) for t in json.load(sys.stdin)['tools']]"

# Run one: POST the arguments as JSON
curl -s -X POST -H "Authorization: Bearer $HWM_API_TOKEN" -H "Content-Type: application/json" \
  "$HWM_API_URL/tools/profit_and_loss" -d '{}'
curl -s -X POST -H "Authorization: Bearer $TAM_API_TOKEN" -H "Content-Type: application/json" \
  "https://theachievemint.com/api/v1/tools/revenue" -d '{"since":"2026-08-18","until":"2026-11-16"}'
```

The ones asked for most:

| question | where | tool |
|---|---|---|
| sales for any dates, by shop, against the span before | hwm_app | `orders` |
| site orders and revenue as the store itself counts them (paid only) | TAM | `revenue` |
| orders to ship, today's revenue, the engraving queue | TAM | `shop_dashboard` |
| profit, fees, shipping, taxes | hwm_app | `profit_and_loss`, `books_overview`, `tax_estimate` |
| ad spend and what it earned | hwm_app | `ads_performance` |
| site visitors and where they came from | hwm_app `tam_traffic`, TAM `site_traffic` |
| one customer, one order, one engraving job | TAM | `search_orders`, `read_order`, `read_customer`, `read_engraving_job` |

Only read tools are offered there. Anything that changes or sends goes
through the endpoints in the rest of this file and the task API.

---

## Notes

### Recent notes
```bash
curl -s -H "Authorization: Bearer $HWM_API_TOKEN" "$HWM_API_URL/notes?limit=10"
```

### Read full note
```bash
curl -s -H "Authorization: Bearer $HWM_API_TOKEN" "$HWM_API_URL/notes/NOTE_ID"
```

---

## Contacts

### Search contacts
```bash
curl -s -H "Authorization: Bearer $HWM_API_TOKEN" "$HWM_API_URL/contacts?query=TERM&limit=20"
```
Add `&starred=true` for starred contacts only.

---

## Weather

### Current weather + forecast
```bash
curl -s -H "Authorization: Bearer $HWM_API_TOKEN" "$HWM_API_URL/weather"
```
Returns current conditions + today's and tomorrow's high/low.

---

## Briefings

### Past briefings
```bash
curl -s -H "Authorization: Bearer $HWM_API_TOKEN" "$HWM_API_URL/briefings?limit=7"
```

### Raw briefing context (all data sources assembled)
```bash
curl -s -H "Authorization: Bearer $HWM_API_TOKEN" "$HWM_API_URL/briefings/context?type=morning"
```
Type: `morning` or `evening`. Returns the full data context used to generate briefings.

---

## Daily Briefing Guide

Adam gets morning (6 AM ET) and evening (6 PM ET) briefings. When generating one:

1. Call `/briefings/context?type=morning` (or evening) to get all data
2. Use the data to write a briefing in this style:
   - **Tone**: Smart, practical friend. Direct, no fluff. No "you've got this!" cliches.
   - **Morning**: Weather → calendar → inbox update → yesterday's wins → today's priorities → overdue items → orders → data insight → side note → quote
   - **Evening**: Today's accomplishments → tomorrow preview → inbox wrap-up → evening thought → quote
3. Keep it concise. Each section 1-3 sentences max.
4. The "side note" or "evening thought" should be fresh and personal — check past briefings to avoid repeating themes.

---

## Texting Adam — when you are stuck

If something stops you working, text him. Do not stop and wait to be noticed.

```bash
curl -s -X POST -H "Authorization: Bearer $HWM_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Sposedly collection is blocked: 438 tasks waiting, and I need a ruling on X before I read another shop."}' \
  https://app.hardworkmontage.com/api/v1/texts
```

One line, no attachments, cut at a thousand characters. This is the only route
you have to his phone — every in-app destination is a chat panel he may not be
looking at. A Sposedly question once sat in one for thirty hours while the
queue grew to 438 tasks and nothing read a shop.

Texting him is not a reason to stop. Say what is wrong, take the conservative
path, and keep working.

## Voice Calls — calling Adam directly (Phase 1: dial + iMessage fallback)

You can place an actual phone call to Adam through the HWM API. This is for
moments where text isn't enough — you genuinely need a quick verbal answer.
Phase 1 doesn't have a live voice bridge yet (so on pickup Adam hears a
short placeholder and the call hangs up); the fallback iMessage carries
your real question if he doesn't pick up.

**When to call vs text vs iMessage:**

- Text/iMessage: anything routine, anything async, anything that fits in writing.
- Phone call: rare. Time-sensitive yes/no, ambiguity that text round-trips poorly,
  or a moment where the user has *asked* you to call.

**Quiet hours: 8am – 9pm America/New_York.** Outside that window the API
returns 422 with `quiet_hours: true`. Don't retry until morning — send an
iMessage instead.

### Place a call

```bash
curl -s -X POST -H "Authorization: Bearer $HWM_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Quick yes/no on the Etsy refund — buyer wants both items returned, $42 total. Approve?",
    "fallback_text": "Tried calling about the Etsy refund: buyer wants both items returned ($42 total). Approve? Reply yes/no."
  }' \
  "$HWM_API_URL/calls"
```

- `prompt`: what *you* wanted to ask Adam. Short, specific, one question.
- `fallback_text`: the iMessage that goes out if Adam doesn't pick up.
  Make it standalone — Adam may read it without seeing the prompt.

Response:
```json
{ "id": 17, "status": "queued", ... }
```

### Poll call status

```bash
curl -s -H "Authorization: Bearer $HWM_API_TOKEN" "$HWM_API_URL/calls/17"
```

Statuses: `queued` → `placing` → `ringing` → `answered` → `completed`,
or terminal `no_answer` / `busy` / `failed` / `fallback_imessage`.
The `fallback_imessage` status means the iMessage went out — you don't
need to send another.

### Recent calls

```bash
curl -s -H "Authorization: Bearer $HWM_API_TOKEN" "$HWM_API_URL/calls"
```

## Important Notes

- Adam is in **Eastern Time** (America/New_York)
- Email domains: hwm.llc (primary: adam@hwm.llc), theachievemint.com
- Convert natural language times to ISO 8601 for snooze/scheduling
- Order sources: etsy, achievemint (the website). Amazon is discontinued; leave it out of every total
