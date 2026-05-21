---
name: voice-delegation
description: When Adam is on a phone call with the in-call version of you and asks for something the in-call toolset can't do (browser navigation, full email reading, multi-step research), it lands here as `[VOICE DELEGATION]`. You do the work and iMessage Adam the result.
---

# Voice Delegations — phone-Burnie's escape hatch

Adam can call you (Burnie) at +1 704 703 8341. The in-call version of you (running on the voice bridge) has only four tools: `create_todo`, `create_note`, `search_email`, `lookup_contact`. Anything beyond that — navigating Chrome, reading full email bodies, multi-step research — is delegated to **you** (the Mini-self with browser access + the full hwm-api surface).

When that happens, the call's in-call self fires `delegate_to_burnie(task: "...")` and a `[VOICE DELEGATION]` prompt arrives in your nanoclaw inbox.

## When you see `[VOICE DELEGATION]`

The prompt will include:

```
[VOICE DELEGATION]
call_id: <numeric or unknown>
source: voice_bridge
imessage_recipient: +1XXXXXXXXXX

<the task description, written by phone-Burnie>
```

## Your job

1. **Do the work.** Use any tool that fits:
   - **host-browser** skill — Chrome / Etsy / Amazon Seller / any logged-in site
   - **hwm-api** skill — emails, todos, notes, calendar, contacts, social, briefings, bookkeeping, spreadsheets
   - **Bash / Read / Write** in your sandbox for analysis
   - There's no latency budget here. The call is over by the time you read this. Take as long as you need to do it right.

2. **Check what Adam already got via iMessage in the last 30 minutes** — BEFORE you send anything. The dispatcher moves successful sends to `~/nanoclaw/data/imessage_sent/`. The big trap this guards against: an inbound Etsy email auto-iMessages Adam via `Etsy::DispatchNextJob`, then he calls you and asks "check Etsy", and you'd be telling him about the same customer message he saw 10 minutes ago.

   ```bash
   # Recently sent (last 30 min)
   find /Users/burnie/nanoclaw/data/imessage_sent -name "*.json" \
     -newermt "30 minutes ago" -exec cat {} \; 2>/dev/null
   # Plus anything queued but not yet picked up by the dispatcher
   # (runs every 10s; rare but possible to race)
   find /Users/burnie/nanoclaw/data/imessage_outbox -name "*.json" \
     -exec cat {} \; 2>/dev/null
   ```

   Read those `body` fields. If your planned message overlaps substantially (same Etsy customer, same email subject, same gist), pick one of:
   - **Skip the iMessage entirely** if there's nothing genuinely new. Trust that Adam already got it.
   - **Send a scoped follow-up** that adds new info on top — "Following up on the Etsy msg from brittany you got 12 min ago: I checked the order, it shipped Tuesday, tracking shows out for delivery today." Don't re-quote the original message.

   If there's no overlap, send the full message normally.

3. **iMessage Adam the result.** Drop a JSON file in your imessage outbox — `imessage_dispatch.rb` (running via launchd every 10s) picks it up and sends via Messages.app:

   ```bash
   FNAME="voice-$(date +%s%N | tail -c 10)-$RANDOM.json"
   cat > /Users/burnie/nanoclaw/data/imessage_outbox/$FNAME <<JSON
   {"to":"<recipient_from_prompt>","body":"<your message>","queued_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
   JSON
   ```

   Format the iMessage:
   - Lead with what Adam asked (one line, scannable on a phone)
   - Then the result — short, no markdown
   - If you couldn't do it, say so honestly with the reason ("Etsy login expired, need you to re-auth on the Mini")

4. **Don't post to /social, don't open a /chat thread.** The result goes only to iMessage. Adam already knows you're on it; he asked for it on the phone. Posting elsewhere is just noise.

## Examples

**Task:** "Open Etsy and check if there are unread messages from the last hour."
- Use the host-browser skill to navigate to etsy.com/messages, scrape unread, summarize.
- iMessage Adam: `🛍️ Etsy unread (last hour): 0 new messages. Last activity was [timestamp].`

**Task:** "Read the full body of the latest email from Sarah and summarize."
- Use hwm-api: `GET /emails/search?query=Sarah&limit=1`, then `GET /emails/<id>`.
- iMessage Adam: `📧 Sarah <subject>: <2-3 sentence summary>. Full thread in /emails/<id>.`

**Task:** "Check if there are any new sales on Amazon Seller Central from today."
- host-browser → sellercentral → today's order count.
- iMessage Adam: `🛒 Amazon: 3 new orders today, $147 total. Most recent at <time>.`

## Why this skill exists

Phone-Burnie has tight latency requirements (ms-level) and a small toolset (the in-call self can't open a browser without breaking conversation flow). You don't have those constraints. The split is: phone-Burnie is for fast, conversational actions; you handle the slow, arbitrary, "go look at the actual website" work.

When in doubt about whether something belongs here vs the in-call tools: if it could feasibly take more than 2 seconds OR needs Chrome / a logged-in site OR involves reading more than a subject line of email content, it's a voice delegation.
