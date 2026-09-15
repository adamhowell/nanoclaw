---
name: theachievemint-smoke
description: Click through The Achieve Mint's golden-path checkout on the live site (add one coin of each form shape to the cart, then address, shipping, payment page) and text Adam whether it passed. Use when a message starts with [CHECKOUT SMOKE], after a theachievemint.com deploy, or when Adam asks whether the store still works. Never completes a payment.
---

# Achieve Mint — checkout smoke test

The host-browser service on the Mini runs the whole walk in its own
headless Chrome and hands back a JSON report. You call it, read the
report, and text Adam one line. You do not click anything yourself.

```bash
curl -sS -X POST "$HOST_BROWSER_URL/smoke" \
  -H "X-Auth: $HOST_BROWSER_TOKEN" -H "Content-Type: application/json" \
  -d '{}' --max-time 300
```

Takes one to three minutes. The reply:

```json
{ "ok": true, "duration_ms": 61000,
  "steps": [ { "name": "add: plain product", "ok": true, "ms": 4200, "detail": "/cart/add 200" }, ... ],
  "js_errors": [], "failure_screenshot_jpeg_base64": null }
```

`ok: false` comes back with HTTP 500 and the first failed step names what
broke. The steps, in order: add each of four products (plain, token with
the engraving box off, personalized coin, fully custom coin), the cart
lists them all, address, a shipping rate comes back, the payment page
shows a Stripe client secret. It stops there. Nothing is bought.

## What to do with the result

1. If it failed, run it ONCE more before saying anything. Shippo and
   Stripe have slow moments and one retry clears most of those.
2. Text Adam ONE line, plain text, no markdown:
   - pass: `✅ theachievemint checkout smoke passed after deploy abc1234 (7 steps, 58s)`
   - fail: `❌ theachievemint checkout smoke FAILED after deploy abc1234 at "add: token, engraving box left off": /cart/add answered 500` and add the first js_errors entry if there is one.
   Use the deploy sha from the message that asked you to run this; if
   there was none, leave it out.
3. Do not try to fix the store, do not re-run in a loop, do not open the
   site with your own browser tools to "double check". The report is the
   check. Adam takes it from there.

If `$HOST_BROWSER_URL/smoke` itself errors (connection refused, 404),
say that instead: the service is down or an old build, which is a
different problem from the store being down.
