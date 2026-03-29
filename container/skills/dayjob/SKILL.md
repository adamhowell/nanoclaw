---
name: dayjob
description: Access Adam's work Microsoft 365 account (Outlook mail, calendar, Teams) via MS Graph API. Use when the user asks about work email, work calendar, or anything related to NexComm/dayjob.
---

# Dayjob — Microsoft 365 Integration

Access Adam's work account (adam.howell@nexcommsp.com) via the Microsoft Graph API using app-level credentials.

## Authentication

Get a bearer token using client credentials (no user login needed):

```bash
TOKEN=$(curl -s -X POST "https://login.microsoftonline.com/$MS_GRAPH_TENANT_ID/oauth2/v2.0/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=$MS_GRAPH_CLIENT_ID&client_secret=$MS_GRAPH_CLIENT_SECRET&scope=https://graph.microsoft.com/.default&grant_type=client_credentials" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
```

All subsequent requests use:
```bash
curl -s -H "Authorization: Bearer $TOKEN" "https://graph.microsoft.com/v1.0/..."
```

The user is: `adam.howell@nexcommsp.com`

## Available Permissions

- **Mail.Read** — read all mailboxes
- **Mail.ReadWrite** — read/write mail
- **Mail.Send** — send mail as the user

## Endpoints

### List recent emails
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/users/adam.howell@nexcommsp.com/messages?\$top=10&\$orderby=receivedDateTime desc&\$select=subject,from,receivedDateTime,bodyPreview,isRead"
```

### Search emails
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/users/adam.howell@nexcommsp.com/messages?\$search=\"TERM\"&\$top=10&\$select=subject,from,receivedDateTime,bodyPreview"
```

### Read specific email (full body)
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/users/adam.howell@nexcommsp.com/messages/MESSAGE_ID?\$select=subject,from,toRecipients,body,receivedDateTime"
```

### List unread emails
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/users/adam.howell@nexcommsp.com/mailFolders/inbox/messages?\$filter=isRead eq false&\$top=10&\$select=subject,from,receivedDateTime,bodyPreview"
```

### Send email
```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  "https://graph.microsoft.com/v1.0/users/adam.howell@nexcommsp.com/sendMail" \
  -d '{
    "message": {
      "subject": "Subject here",
      "body": { "contentType": "Text", "content": "Body here" },
      "toRecipients": [{ "emailAddress": { "address": "recipient@example.com" } }]
    }
  }'
```
**NEVER send work email without showing the user a draft first and getting explicit confirmation.**

### Reply to email
```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  "https://graph.microsoft.com/v1.0/users/adam.howell@nexcommsp.com/messages/MESSAGE_ID/reply" \
  -d '{ "comment": "Reply text here" }'
```
**NEVER send without explicit confirmation.**

### Mark as read
```bash
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  "https://graph.microsoft.com/v1.0/users/adam.howell@nexcommsp.com/messages/MESSAGE_ID" \
  -d '{ "isRead": true }'
```

### List mail folders
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/users/adam.howell@nexcommsp.com/mailFolders?\$select=displayName,totalItemCount,unreadItemCount"
```

## Important Notes

- This is Adam's **work** email at NexComm MSP — be professional in any drafts
- Adam is in **Eastern Time** (America/New_York)
- Always distinguish between work email (dayjob/Outlook) and personal email (HWM API/Fastmail) when the user asks about "email"
- If the user says "work email" or "Outlook" or mentions NexComm, use this skill
- If the user says "email" without context, ask which one or check both
