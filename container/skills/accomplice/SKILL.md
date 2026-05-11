---
name: accomplice
description: Start, end, and inspect focus sessions on hwm_app. Use when Adam says he wants to focus, start a session, go heads-down, end his session, or asks how a session is going / how he did this week.
---

# Accomplice — Focus Sessions

Drive Adam's focus / nudge product (the `/accomplice` surface in hwm_app)
from chat. A "focus contract" is the structured "I'm working on X for
N minutes" record — once one is active, the macOS menubar agent streams
app + browser-navigation signals, Haiku decides if Adam has drifted,
and any nudges get iMessaged to him. On end (manual or auto), Haiku
grades the session.

## When to use this skill

- "I want to focus on …", "starting deep work", "let me go heads-down for …", "lock me in for …" → start a contract.
- "I'm done", "wrap it up", "ending now", "switching tasks", "break time" → end the current contract.
- "how's it going?", "where am I?", "how long left?" → fetch the current contract + snapshot.
- "how was today?", "how did I do this week?", "show me my last few sessions" → fetch recent grades.
- "Slack is work / a distraction", "stop flagging Linear" → upsert an app categorization.

If Adam's message is *short* and ambiguous (e.g. just "let's focus" with no goal), ask **one** clarifying question covering title and duration together, then call the tool — don't run a five-message intake.

## Authentication

All endpoints use the user-token bearer (NOT the device token):

```bash
curl -s -H "Authorization: Bearer $HWM_API_TOKEN" "$HWM_API_URL/accomplice/..."
```

`HWM_API_URL` and `HWM_API_TOKEN` are pre-configured. Same auth Burnie
already uses for `/emails`, `/todos`, etc. via the `hwm-api` skill.

---

## Start a focus session

```bash
curl -s -X POST -H "Authorization: Bearer $HWM_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Stellarai onboarding flow",
    "horizon_minutes": 90,
    "goal": "ship the welcome email",
    "blocked_categories": ["social", "news"],
    "allowed_categories": ["development"],
    "success_signal": "PR opened"
  }' \
  "$HWM_API_URL/accomplice/focus_contracts"
```

**Required:** `title`.
**Defaults:** `horizon_minutes` → 60 (clamped 5..480).
**Optional:** `goal`, `blocked_categories[]`, `allowed_categories[]`, `success_signal`.
`blocked_categories` / `allowed_categories` can be sent as a JSON array
or a comma-separated string.

Returns `201` + `{ "contract": { id, title, status, ends_at, ... } }`.
Returns `409 already_active` if a session is already running — fetch the
current one first and end it before starting a new one.

## End the active focus session

```bash
curl -s -X POST -H "Authorization: Bearer $HWM_API_TOKEN" \
  "$HWM_API_URL/accomplice/focus_contracts/end_current"
```

Idempotent. Closes whichever contract is live (no id needed), fires
grading in the background, and returns `{ contract: {...}, ended: true }`
when something was closed or `{ contract: null, ended: false }` otherwise.

The grade (emoji + headline + detail) writes to the session's `summary`
field a few seconds later — surface it via `/focus_grades` rather than
trying to poll inline.

## Get the current session

```bash
curl -s -H "Authorization: Bearer $HWM_API_TOKEN" \
  "$HWM_API_URL/accomplice/focus_contracts/current"
```

Returns `{ contract: null }` when nothing is live, otherwise
`{ contract: { ..., snapshot: { elapsed_minutes, planned_minutes,
progress_pct, web_visits, nudge_count, escalated_nudge_count,
vibe_score, stage, status } } }`. Use `snapshot` to answer "how's it
going?" without re-prompting Claude.

## Recent grades (the logbook)

```bash
curl -s -H "Authorization: Bearer $HWM_API_TOKEN" \
  "$HWM_API_URL/accomplice/focus_grades?limit=7"
```

Returns up to N graded sessions, newest first:

```json
{
  "grades": [
    {
      "id": 42, "contract_id": 19, "title": "Onboarding flow",
      "started_at": "2026-05-10T15:00:00-04:00",
      "ended_at": "2026-05-10T16:30:00-04:00",
      "duration_minutes": 90,
      "emoji": "🎯", "headline": "Locked in.",
      "detail": "No drift, no nudges — clean 90 minutes."
    }
  ]
}
```

`limit` is clamped 1..50 (default 5). Only sessions that have been
graded (Haiku's `summary.graded_at` is set) show up here.

## Categorize an app

When Adam tells you how to classify an app for nudge decisions
("Slack is work for this", "Linear is a distraction"):

```bash
curl -s -X POST -H "Authorization: Bearer $HWM_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "bundle_id": "com.tinyspeck.slackmacgap",
    "app_name": "Slack",
    "category": "work"
  }' \
  "$HWM_API_URL/accomplice/app_categorizations"
```

`category` is one of `work` | `break` | `distraction`. Upserts on
`bundle_id` (one row per app per user). The next `DecideNudge` call
will see this and skip "is Slack work?" guesses.

---

## Style notes

- Confirm the action plainly after a successful call — "Locked in on
  Stellarai onboarding for 90 min. I'll nudge if you drift." — but
  don't restate every field.
- If `409 already_active` comes back: tell Adam the current title +
  remaining minutes (from `/focus_contracts/current`) and ask if he
  wants to end it first.
- When fetching the logbook, lead with the emoji + headline per row,
  one line each. Don't dump the full detail unless asked.
- Don't render the snapshot's `vibe_score` to Adam — it's an internal
  signal. `stage` is fine ("looking like a young session").
