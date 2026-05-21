---
name: hwm-api
description: Access Adam's email, todos, calendar, orders, notes, contacts, weather, briefings, and voice calls via the HWM API. Use when the user asks about any of these.
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

## Orders (Etsy, Amazon, TheAchieveMint)

### Recent orders
```bash
curl -s -H "Authorization: Bearer $HWM_API_TOKEN" "$HWM_API_URL/orders?days=7&limit=25"
```
Returns total count, total revenue, and orders grouped by source.

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
- Order sources: Etsy, Amazon, TheAchieveMint
