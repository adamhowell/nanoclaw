---
name: dayjob
description: Access Adam's work Microsoft 365 account (Outlook mail, calendar, SharePoint, Teams, files, tasks, contacts, users) via MS Graph API. Use when the user asks about work email, work calendar, meetings, SharePoint, Teams, or anything related to Nexcom/dayjob.
---

# Dayjob — Microsoft 365 Integration

Access the user's work Microsoft 365 account via the Microsoft Graph API using app-level credentials. The target user is determined by the `$MS_GRAPH_USER` environment variable.

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

The user is: `$MS_GRAPH_USER`
The user ID placeholder used below: `USER=$MS_GRAPH_USER`

## Permission Boundaries

This app has **application-level** permissions scoped to the tenant. The agent MUST only access data belonging to `$MS_GRAPH_USER` unless the user explicitly asks about another person. Never enumerate or read other users' mail, calendar, or files without explicit instruction.

Granted permissions:
- **Mail**: Mail.Read, Mail.ReadWrite, Mail.Send
- **Calendar**: Calendars.ReadWrite
- **SharePoint/Files**: Sites.Read.All, Files.Read.All
- **People/Users**: User.Read.All, People.Read.All, Contacts.Read, Presence.Read.All
- **Tasks**: Tasks.ReadWrite
- **Teams**: Team.ReadBasic.All, Channel.ReadBasic.All, Chat.Read.All, ChannelMessage.Read.All
- **Notes**: Notes.Read.All

**CRITICAL RULES:**
1. **NEVER send email or reply without showing the user a draft first and getting explicit confirmation.**
2. **NEVER create/modify/delete calendar events without explicit confirmation.**
3. **NEVER modify tasks without explicit confirmation.**
4. Only access other users' data when Adam explicitly asks (e.g. "check if Sarah is online").
5. Treat all data as confidential work information.

---

## Mail

### List recent emails
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/users/$USER/messages?\$top=10&\$orderby=receivedDateTime desc&\$select=subject,from,receivedDateTime,bodyPreview,isRead"
```

### Search emails
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/users/$USER/messages?\$search=\"TERM\"&\$top=10&\$select=subject,from,receivedDateTime,bodyPreview"
```

### Read specific email (full body)
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/users/$USER/messages/MESSAGE_ID?\$select=subject,from,toRecipients,body,receivedDateTime"
```

### List unread emails
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/users/$USER/mailFolders/inbox/messages?\$filter=isRead eq false&\$top=10&\$select=subject,from,receivedDateTime,bodyPreview"
```

### Send email
```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  "https://graph.microsoft.com/v1.0/users/$USER/sendMail" \
  -d '{
    "message": {
      "subject": "Subject here",
      "body": { "contentType": "Text", "content": "Body here" },
      "toRecipients": [{ "emailAddress": { "address": "recipient@example.com" } }]
    }
  }'
```

### Reply to email
```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  "https://graph.microsoft.com/v1.0/users/$USER/messages/MESSAGE_ID/reply" \
  -d '{ "comment": "Reply text here" }'
```

### Mark as read
```bash
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  "https://graph.microsoft.com/v1.0/users/$USER/messages/MESSAGE_ID" \
  -d '{ "isRead": true }'
```

### List mail folders
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/users/$USER/mailFolders?\$select=displayName,totalItemCount,unreadItemCount"
```

---

## Calendar

### List today's events
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  -H "Prefer: outlook.timezone=\"America/New_York\"" \
  "https://graph.microsoft.com/v1.0/users/$USER/calendarView?\$top=20&startDateTime=$(date -u +%Y-%m-%dT00:00:00Z)&endDateTime=$(date -u +%Y-%m-%dT23:59:59Z)&\$orderby=start/dateTime&\$select=subject,start,end,location,organizer,isAllDay,showAs,responseStatus"
```

### List upcoming events (next 7 days)
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  -H "Prefer: outlook.timezone=\"America/New_York\"" \
  "https://graph.microsoft.com/v1.0/users/$USER/calendarView?\$top=50&startDateTime=$(date -u +%Y-%m-%dT%H:%M:%SZ)&endDateTime=$(date -u -v+7d +%Y-%m-%dT23:59:59Z)&\$orderby=start/dateTime&\$select=subject,start,end,location,organizer,isAllDay,showAs,attendees"
```

### Get event details
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/users/$USER/events/EVENT_ID?\$select=subject,body,start,end,location,attendees,organizer,isOnlineMeeting,onlineMeeting"
```

### Create event
```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  "https://graph.microsoft.com/v1.0/users/$USER/events" \
  -d '{
    "subject": "Meeting title",
    "start": { "dateTime": "2026-04-07T14:00:00", "timeZone": "America/New_York" },
    "end": { "dateTime": "2026-04-07T15:00:00", "timeZone": "America/New_York" },
    "attendees": [{ "emailAddress": { "address": "person@example.com" }, "type": "required" }],
    "isOnlineMeeting": true,
    "onlineMeetingProvider": "teamsForBusiness"
  }'
```

### Update event
```bash
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  "https://graph.microsoft.com/v1.0/users/$USER/events/EVENT_ID" \
  -d '{ "subject": "Updated title" }'
```

### Delete event
```bash
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/users/$USER/events/EVENT_ID"
```

### Accept/decline/tentative
```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  "https://graph.microsoft.com/v1.0/users/$USER/events/EVENT_ID/accept" \
  -d '{ "sendResponse": true, "comment": "See you there!" }'
# Also: /decline, /tentativelyAccept
```

### Find free/busy times
```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  "https://graph.microsoft.com/v1.0/users/$USER/calendar/getSchedule" \
  -d '{
    "schedules": ["$MS_GRAPH_USER", "other@nexcommsp.com"],
    "startTime": { "dateTime": "2026-04-07T08:00:00", "timeZone": "America/New_York" },
    "endTime": { "dateTime": "2026-04-07T18:00:00", "timeZone": "America/New_York" },
    "availabilityViewInterval": 30
  }'
```

---

## SharePoint & Files

### List sites the user has access to
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/sites?\$search=*&\$top=20&\$select=displayName,webUrl,id"
```

### Search SharePoint
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/sites?\$search=\"TERM\"&\$select=displayName,webUrl,id"
```

### Get site by path
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/sites/nexcommsp.sharepoint.com:/sites/SITE_NAME"
```

### List document libraries in a site
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/sites/SITE_ID/drives?\$select=name,id,webUrl"
```

### List files in a drive/folder
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/drives/DRIVE_ID/root/children?\$select=name,size,lastModifiedDateTime,webUrl,file,folder"
```

### List files in subfolder
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/drives/DRIVE_ID/root:/path/to/folder:/children"
```

### Search files across drives
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/drives/DRIVE_ID/root/search(q='TERM')?\$select=name,webUrl,lastModifiedDateTime,size"
```

### Download file content
```bash
curl -s -L -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/drives/DRIVE_ID/items/ITEM_ID/content" -o filename.ext
```

### Get file metadata
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/drives/DRIVE_ID/items/ITEM_ID?\$select=name,size,lastModifiedDateTime,webUrl,createdBy,lastModifiedBy"
```

### List SharePoint lists
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/sites/SITE_ID/lists?\$select=displayName,id,webUrl"
```

### Get list items
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/sites/SITE_ID/lists/LIST_ID/items?\$expand=fields&\$top=25"
```

### User's OneDrive root
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/users/$USER/drive/root/children?\$select=name,size,lastModifiedDateTime,webUrl,file,folder"
```

---

## Teams

### List teams the user is in
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/users/$USER/joinedTeams?\$select=displayName,id,description"
```

### List channels in a team
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/teams/TEAM_ID/channels?\$select=displayName,id,description"
```

### Read channel messages (recent)
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/teams/TEAM_ID/channels/CHANNEL_ID/messages?\$top=20"
```

### Read chat messages
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/users/$USER/chats?\$top=10&\$select=topic,chatType,lastUpdatedDateTime"
```

### Get messages from a specific chat
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/chats/CHAT_ID/messages?\$top=20"
```

---

## Tasks (Microsoft To Do)

### List task lists
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/users/$USER/todo/lists?\$select=displayName,id"
```

### List tasks in a list
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/users/$USER/todo/lists/LIST_ID/tasks?\$filter=status ne 'completed'&\$select=title,status,importance,dueDateTime,createdDateTime"
```

### Create task
```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  "https://graph.microsoft.com/v1.0/users/$USER/todo/lists/LIST_ID/tasks" \
  -d '{
    "title": "Task title",
    "importance": "normal",
    "dueDateTime": { "dateTime": "2026-04-10T00:00:00", "timeZone": "America/New_York" }
  }'
```

### Complete task
```bash
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  "https://graph.microsoft.com/v1.0/users/$USER/todo/lists/LIST_ID/tasks/TASK_ID" \
  -d '{ "status": "completed" }'
```

### Delete task
```bash
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/users/$USER/todo/lists/LIST_ID/tasks/TASK_ID"
```

---

## People & Users

### Search people (frequent contacts / org)
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/users/$USER/people?\$search=\"NAME\"&\$top=10&\$select=displayName,emailAddresses,jobTitle,department"
```

### Look up a user profile
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/users/USER_EMAIL?\$select=displayName,mail,jobTitle,department,officeLocation,mobilePhone,businessPhones"
```

### Get user's manager
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/users/USER_EMAIL/manager?\$select=displayName,mail,jobTitle"
```

### Get user's direct reports
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/users/USER_EMAIL/directReports?\$select=displayName,mail,jobTitle"
```

### Check presence (online/away/busy)
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/users/USER_EMAIL/presence"
```

### List Outlook contacts
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/users/$USER/contacts?\$top=20&\$select=displayName,emailAddresses,businessPhones,companyName,jobTitle"
```

### Search contacts
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/users/$USER/contacts?\$filter=startsWith(displayName,'NAME')&\$select=displayName,emailAddresses"
```

---

## OneNote

### List notebooks
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/users/$USER/onenote/notebooks?\$select=displayName,id,lastModifiedDateTime"
```

### List sections in a notebook
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/users/$USER/onenote/notebooks/NOTEBOOK_ID/sections?\$select=displayName,id"
```

### List pages in a section
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/users/$USER/onenote/sections/SECTION_ID/pages?\$select=title,id,createdDateTime,lastModifiedDateTime"
```

### Get page content
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/users/$USER/onenote/pages/PAGE_ID/content"
```

---

## Important Notes

- This is the user's **work** account — be professional in any drafts
- The user's timezone is set via the `$TZ` environment variable
- Always distinguish between work email (dayjob/Outlook) and personal email when the user asks about "email"
- If the user says "work email" or "Outlook" or mentions Nexcom, use this skill
- Calendar times should always be displayed in the user's timezone
- When listing meetings, include the Teams join link if `isOnlineMeeting` is true
