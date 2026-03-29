---
name: email
description: Read, search, reply, archive, and snooze emails via the HWM API. Use when the user asks about email, inbox, or wants to send/manage messages.
---

# Email Management

You can manage Adam's email through the HWM API. Use `curl` with the API token from the environment.

## Setup

The API base URL and token are available as environment variables:
- `HWM_API_URL` = `https://app.hardworkmontage.com/api/v1`
- `HWM_API_TOKEN` — Bearer token for authentication

All requests use:
```bash
curl -s -H "Authorization: Bearer $HWM_API_TOKEN" "$HWM_API_URL/endpoint"
```

## Available Endpoints

### List unread emails
```bash
curl -s -H "Authorization: Bearer $HWM_API_TOKEN" "$HWM_API_URL/emails/unread?limit=10"
```
Returns `{ unread_count, emails: [...] }`

### Search emails
```bash
curl -s -H "Authorization: Bearer $HWM_API_TOKEN" "$HWM_API_URL/emails/search?query=TERM&folder=inbox&limit=10"
```
Folder options: `inbox`, `sent`, `archived`, `all` (default: all)

### Read a single email (full body)
```bash
curl -s -H "Authorization: Bearer $HWM_API_TOKEN" "$HWM_API_URL/emails/EMAIL_ID"
```

### Read full email thread
```bash
curl -s -H "Authorization: Bearer $HWM_API_TOKEN" "$HWM_API_URL/emails/EMAIL_ID/thread"
```

### Send a reply
```bash
curl -s -X POST -H "Authorization: Bearer $HWM_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"body":"Reply text here","archive":true}' \
  "$HWM_API_URL/emails/EMAIL_ID/reply"
```
**IMPORTANT:** Never send a reply without showing the user the draft first and getting explicit confirmation.

### Archive email/thread
```bash
curl -s -X POST -H "Authorization: Bearer $HWM_API_TOKEN" \
  -d '{"whole_thread":true}' \
  "$HWM_API_URL/emails/EMAIL_ID/archive"
```

### Snooze email
```bash
curl -s -X POST -H "Authorization: Bearer $HWM_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"snooze_until":"2026-03-29T09:00:00"}' \
  "$HWM_API_URL/emails/EMAIL_ID/snooze"
```
The user is in Eastern Time (America/New_York). Convert natural language times to ISO 8601.

### Trigger email sync
```bash
curl -s -X POST -H "Authorization: Bearer $HWM_API_TOKEN" "$HWM_API_URL/emails/sync"
```

## Email Reply Workflow

When the user asks you to reply to an email:
1. Use search or list_unread to find the email
2. Read the thread for full context
3. Draft a reply and **show it to the user for approval**
4. Only after the user confirms, call the reply endpoint
5. Report success/failure

**NEVER send a reply without explicit user confirmation.**

## Email Summary Format

When listing emails, format them clearly:
```
From: Sender Name <email@example.com>
Subject: The subject line
Date: March 28, 2026 at 3:00 PM
Preview: First few lines of the email...
[ID: 123]
```

## Domains

Adam has these email domains configured:
- hwm.llc (primary: adam@hwm.llc)
- theachievemint.com
