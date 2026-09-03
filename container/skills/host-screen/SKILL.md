---
name: host-screen
description: Change something on Etsy (or any bot-protected, logged-in site) by looking at the Mac Mini's screen and clicking, typing and pressing keys like a person. Use this for ANY edit on etsy.com — listing descriptions, personalization setup, order stages, anything with a Save button. Reads still go through host-browser; this is for acting.
---

# Host Screen — see the Mini's display and act on it

Etsy's listing editor is a React app. Typing into it through a selector and
then clicking Save in a second request reloads the page in between, so the
edit is thrown away and Save never enables (that is what stopped the
2026-09-02 description sync after one listing). A person never has that
problem, because a person looks at the page and acts on what they see. This
route gives you the same thing: a screenshot of the Mini's display, and a
mouse and keyboard that work on it.

Nothing here knows what a selector is. Do not look for one.

## Endpoint

Same service, same auth as host-browser:

```
POST $HOST_BROWSER_URL/screen
-H "X-Auth: $HOST_BROWSER_TOKEN" -H "Content-Type: application/json"
```

The display is **1440 x 900** and the screenshot is the same size, so a
pixel in the picture is the point you click. Every response except the
screenshot is JSON with `"ok": true` or an `"error"`.

## Actions

Look:

```bash
curl -fsS -X POST "$HOST_BROWSER_URL/screen" -H "X-Auth: $HOST_BROWSER_TOKEN" \
  -H "Content-Type: application/json" -d '{"action":"screenshot"}' -o /tmp/screen.png
test $(stat -c%s /tmp/screen.png 2>/dev/null || stat -f%z /tmp/screen.png) -gt 10000 || echo "bad screenshot"
```

Then `Read /tmp/screen.png`. The `-fsS` and the size check matter for the
same reason they do on `/screenshot`: an error body saved as a .png poisons
the session.

Act (all JSON bodies):

| body | what happens |
|---|---|
| `{"action":"focus"}` | brings Chrome to the front. Do this first, every time. |
| `{"action":"click","x":700,"y":420}` | one left click at that point |
| `{"action":"double_click","x":..,"y":..}` | double click (selects a word) |
| `{"action":"right_click","x":..,"y":..}` | right click |
| `{"action":"move","x":..,"y":..}` | move the pointer without clicking (hover menus) |
| `{"action":"drag","x":..,"y":..,"to":{"x":..,"y":..}}` | press, drag, release |
| `{"action":"type","text":"..."}` | pastes the text into whatever has focus. Use this for anything longer than a few words. `\n` in the text is a real line break. |
| `{"action":"type","text":"...","method":"keys"}` | types it key by key instead, for the rare field that ignores paste |
| `{"action":"keys","keys":["cmd+a","delete"]}` | key combos in order. Names: `cmd`, `shift`, `alt`, `ctrl`, `return`, `tab`, `esc`, `delete` (backspace), `space`, `page-down`, `page-up`, `arrow-down`, `home`, `end`, single letters. |
| `{"action":"position"}` | where the pointer is |

The request finishes when the click or keystroke has been sent, not when
the page has reacted. After anything that changes the page, wait a second
or two and take a screenshot before deciding what to do next.

## The loop

Every action is look, act, look. Never chain two clicks on the strength of
one screenshot: menus open, modals land (Etsy's survey popup), pages scroll,
and a click aimed at a stale picture lands on the wrong thing.

1. `focus`, then `screenshot`. Find the thing you want.
2. One action.
3. `screenshot` again. Confirm it did what you meant. If it didn't, stop and
   work out why before the next click.

## Replacing text in a field

1. Click inside the field.
2. `keys: ["cmd+a"]` to select everything in it.
3. `type` the new text with `"method":"keys"`. **Etsy's listing description
   field ignores a paste** (found 2026-09-02: the paste-style type reported
   ok and the field did not change, while key-by-key registered as a real
   unsaved edit). Paste is fine for the address bar and plain inputs.
4. Screenshot. Read the first line and the last line of what is now in the
   field and check they match what you sent. If characters went missing,
   discard the change and tell Adam rather than saving a garbled listing.

## Going to a page

`focus`, then `keys: ["cmd+l"]`, `type` the URL, `keys: ["return"]`, wait
two seconds, screenshot. Use the exact Etsy paths from the host-browser
skill. Page loads made this way do not count against host-browser's hourly
budget, so pace yourself the way a person would instead: a listing every
few minutes, a ten minute break every ten listings, and a full stop for the
day if Etsy shows a captcha, a "verify you are human" page, or logs you out.
Say so to Adam when that happens; do not try to click through it.

## Scrolling

There is no scroll action. Use `keys: ["page-down"]` or `["arrow-down"]`
with the page focused, or drag the scrollbar. **Click on empty page
background first, never with a field focused**: a page-up sent while the
description field held a selection replaced the whole description with
nothing (trial two, 2026-09-02). Screenshot after each scroll.

## Rules

- **Only inside Chrome.** If the screenshot shows a macOS dialog, a
  permission prompt, a Software Update banner covering what you need, or
  anything that is not the Chrome window, stop and tell Adam. Never click
  Allow, Don't Allow, Quit, or anything in the Dock or menu bar.
- **Only the change you were asked for.** On a listing, that means the
  field you were told to change and its Save button. Never Deactivate,
  Delete, Renew, or change price, quantity, photos, tags or shipping.
- **Confirm before you record it.** A sync is not done until a screenshot
  after Save shows the saved state (Etsy's "Changes saved" toast, or the
  page reloaded with the new text in place). Only then call TAM's
  `mark_etsy_listing_synced`.
- **One at a time, first one to Adam.** The first listing of any new kind of
  edit is a trial: do it, send Adam the before and after screenshots, and
  wait for his go before doing the rest.
- Reading still goes through host-browser `/fetch` and `/screenshot`. Use
  this route to act, not to scrape.

## Failure modes

- `{"error":"unknown action ..."}`: check the action name against the table.
- `{"error":"... must be an integer 0..8192"}`: coordinates must be whole numbers.
- `{"error":"Command failed: ssh ..."}`: the Mini's own ssh hop is down.
  Tell Adam; nothing on your side fixes it.
- Screenshot shows the desktop with no Chrome: Chrome crashed or was
  closed. host-browser's `/health` will say `chrome_connected: false`; the
  watchdog restarts it within a minute. Wait and screenshot again.
- The click landed but nothing changed: the page was still loading, or
  something sits on top of the target. Screenshot, look for the overlay,
  and deal with that first.
