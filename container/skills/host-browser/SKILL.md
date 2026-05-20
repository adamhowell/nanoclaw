---
name: host-browser
description: Fetch real web pages through Adam's Mac Mini's persistent macOS Chromium. Use this for ANY URL that requires login (Etsy seller messages, Amazon Seller Central, Shopify, Stripe dashboard, Mercury) OR any site that aggressively bot-blocks (DataDome, Cloudflare, Imperva). Cookies for already-logged-in sites are persisted, so you read pages exactly as Adam would.
---

# Host Browser — real macOS Chrome for authed/protected sites

When you need to read content from a site that has bot protection or
requires being logged in, do NOT use `agent-browser` (Playwright in
the container) or `WebFetch`. Both come from a Linux datacenter IP
with a headless Chromium fingerprint that Etsy, Amazon, Cloudflare,
etc. block on sight.

Instead, hit the host browser service. It runs on the Mac Mini host,
in **headed Chrome.app** (not Chromium) with a long-lived persistent
profile that holds Adam's real login cookies. From the site's
perspective, your fetches look identical to Adam clicking around in
his own browser.

## Endpoint

```
HOST_BROWSER_URL = http://192.168.64.1:8765
```

(Set in your container env. Use `$HOST_BROWSER_URL` if available, else
the literal URL above.)

## Authentication — REQUIRED

Every request must carry an `X-Auth` header matching the
`HOST_BROWSER_TOKEN` env var in your container. Without it the
service returns `401 unauthorized` and your fetch fails silently.

```bash
curl -s "$HOST_BROWSER_URL/health" -H "X-Auth: $HOST_BROWSER_TOKEN"
```

If you ever see `{"error":"unauthorized"}` in the response, **the
service is fine** — your container is missing `HOST_BROWSER_TOKEN`,
or you forgot the header. Don't conclude "host-browser is broken"
and tell Adam to fix it. Either:

1. Re-export your env: `source /workspace/group/accomplice_api.env`
   then retry with `-H "X-Auth: $HOST_BROWSER_TOKEN"`.
2. If `HOST_BROWSER_TOKEN` is genuinely unset in your environment,
   that's the only thing to flag to Adam — not the service itself.

Every example below includes the header. Don't skip it.

## When NOT to use

**Never** use host-browser for `app.hardworkmontage.com` or any other
of Adam's own apps. They are not bot-protected, and you already have:

- An `HWM_API_TOKEN` in your env for the JSON API at
  `https://app.hardworkmontage.com/api/v1`.
- The hwm_app source code mounted at `/workspace/group/hwm_app/` — you
  can `grep` routes, models, controllers directly to figure out what
  the API supports.

Reaching for a screenshot to "see what the page looks like" on an
internal app is a debugging anti-pattern borrowed from real
bot-protected sites. For our own Rails apps, instead:

1. Read the API response body — it'll have the answer.
2. Grep the source at `/workspace/group/hwm_app/` for the route /
   controller / model.
3. Ask Adam if the API surface doesn't expose what you need (don't
   work around it with a screenshot).

Getting this wrong has bitten us — see "Failure modes" below.

## When to use

ALWAYS use host-browser for:

- **etsy.com** — any URL on Etsy. Especially message threads
  (`https://www.etsy.com/messages/...`) and seller pages. Etsy uses
  DataDome which 403s any non-residential or headless browser.
- **sellercentral.amazon.com** — Amazon Seller Central.
- **dashboard.stripe.com** — Stripe dashboard pages.
- **app.mercury.com** — Mercury banking.
- **shopify.com / *.myshopify.com** — Shopify admin / store pages.
- Any URL where you've previously gotten 403 / "Access denied" /
  Cloudflare challenge / DataDome captcha pages.

For unauthenticated public pages (news articles, docs, GitHub repos,
etc.) `WebFetch` and `agent-browser` are still fine — host-browser is
slower because it spins up a real browser, so reserve it for the
auth/bot-protection cases.

## API

All endpoints return JSON unless noted. POST bodies are JSON.

### Fetch a page (most common)

```bash
curl -s -X POST "$HOST_BROWSER_URL/fetch" \
  -H "X-Auth: $HOST_BROWSER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://www.etsy.com/messages",
    "extract": "text",
    "waitMs": 1500
  }'
```

Response:

```json
{
  "final_url": "https://www.etsy.com/messages",
  "status": 200,
  "title": "Etsy - Messages",
  "content": "..."
}
```

Parameters:
- `url` (required) — the page to load.
- `extract` — `"text"` (default, plain visible text), `"html"` (full
  HTML), or `"markdown"` (lightweight markdown rendering with links
  preserved).
- `waitFor` — optional CSS selector to wait for before extracting.
  Use this when the page renders the content you want via JS after
  initial load. Example: `".message-thread-list"` for an Etsy
  conversation thread.
- `waitMs` — extra wait in ms (max 10000). Use 1500-3000 for SPAs.
- `headers` — optional extra request headers as an object.
- `ephemeral` — if `true`, opens a fresh tab and closes it after the
  fetch. Default is `false` — tabs stick per-domain so visit/close
  rhythm doesn't look like automation. Only set this for one-off
  arbitrary URLs you'll never revisit (random news article scrape,
  etc.). Anything on Etsy / Amazon Seller / Stripe should be sticky.

### Extract a specific selector with a click first

For "click 'Show full message' then extract the body" flows:

```bash
curl -s -X POST "$HOST_BROWSER_URL/click" \
  -H "X-Auth: $HOST_BROWSER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://www.etsy.com/messages/123",
    "selector": "button.expand-message",
    "waitFor": ".message-body",
    "extract": "text"
  }'
```

### Screenshot a page

Use this when you need to *show* the user what a page looked like
(returns image/png, not JSON):

```bash
curl -fsS -X POST "$HOST_BROWSER_URL/screenshot" \
  -H "X-Auth: $HOST_BROWSER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://...", "fullPage": true, "waitMs": 2000}' \
  -o /tmp/screenshot.png
```

**The `-f` flag is mandatory.** Without it, a 401/403/500 from the
service writes the JSON error body into your `.png` file (e.g.
24 bytes of `{"error":"unauthorized"}`). If you then `Read` that file,
Claude tries to decode JSON as PNG, the API returns
`Could not process image`, and the bad image is permanently baked
into the session transcript — every `--resume` re-sends it and
re-fails. With `-fsS`, curl exits non-zero on HTTP errors and
writes nothing.

After the screenshot, sanity-check the file size before reading it:

```bash
test $(stat -f%z /tmp/screenshot.png 2>/dev/null || stat -c%s /tmp/screenshot.png) -gt 1000 \
  || { echo "screenshot is suspiciously small — probably an error response"; exit 1; }
```

### Health check

```bash
curl -s "$HOST_BROWSER_URL/health" -H "X-Auth: $HOST_BROWSER_TOKEN"
# {"ok":true,"profile":"...","headless":false,"pid":...}
```

## Tips

- **First call to a domain may be slow** (3-10 seconds). Subsequent
  calls reuse the same Chrome context and are fast (<1s).
- If you get a 403 or login wall on a site you expected to be logged
  into, ask Adam to run `npm run login -- <preset>` on the Mini
  (presets include `etsy`, `amazon-seller`, `stripe`, `shopify`,
  `mercury`). Cookies persist across restarts.
- Always pass `waitMs: 1500-3000` or a `waitFor` selector for SPAs —
  raw HTML before hydration is mostly skeleton loading text.
- For Etsy message threads specifically, the URL format the email
  uses is a tracking redirect:
  `https://ablink.account.etsy.com/ss/c/...`. Pass it directly to
  `/fetch` — host-browser will follow the redirect and land on the
  real `etsy.com/messages/{id}` page (still logged in).
- **Etsy URL paths are inconsistent — use exactly these:**
  - Messages inbox: `https://www.etsy.com/messages` (NOT `/your/messages`)
  - Specific conversation: `https://www.etsy.com/messages/{id}`
  - Shop dashboard: `https://www.etsy.com/your/shops/me/dashboard`
  - Account settings: `https://www.etsy.com/your/account`
  Don't extrapolate. Wrong paths trigger Cloudflare/DataDome and
  can burn the session reputation. The Mini has a permanent tab
  on `etsy.com/messages` that the host-browser-service adopts —
  hitting that URL will reuse it instead of opening a duplicate.
- Never paste cookie values from this service into prompts or files.
  Cookies live in the persistent profile only.

## Failure modes

- **`{"error":"unauthorized"}` (HTTP 401):** you forgot the
  `-H "X-Auth: $HOST_BROWSER_TOKEN"` header, or `HOST_BROWSER_TOKEN`
  isn't set in your container env. Re-export from
  `/workspace/group/accomplice_api.env`, retry. Don't tell Adam
  "the service is broken" without confirming the header is set.
- `503` from the service: the browser context crashed. It auto-
  reopens on the next request — just retry once.
- `status: 403` in the JSON response: site is still bot-blocking. The
  cookie probably expired — alert Adam that re-login is needed.
- `status: 200` but `content` is empty / short: the page rendered
  with JS — pass a `waitFor` selector that matches the actual
  content area.
- **24-byte `.png` containing JSON**: you used `curl` without `-f` on
  the `/screenshot` endpoint and the service returned 401/403/500.
  Curl wrote the error body into the file. If you `Read` that file,
  the Claude API returns `Could not process image` and the bad image
  is baked into the session transcript — every resume re-fails.
  Always use `curl -fsS` and size-check the output (see Screenshot
  section). If you've already poisoned a session with this pattern,
  it's not recoverable from inside the agent — Adam needs to delete
  the session jsonl on Burnie to recover.
