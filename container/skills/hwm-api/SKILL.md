---
name: hwm-api
description: Access Adam's email, todos, calendar, orders, notes, contacts, weather, and briefings via the HWM API. Use when the user asks about any of these.
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

## Important Notes

- Adam is in **Eastern Time** (America/New_York)
- Email domains: hwm.llc (primary: adam@hwm.llc), theachievemint.com
- Convert natural language times to ISO 8601 for snooze/scheduling
- Order sources: Etsy, Amazon, TheAchieveMint
