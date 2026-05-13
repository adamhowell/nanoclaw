---
name: theachievemint-fulfill
description: Process pending Achieve Mint orders end-to-end — match a front template, override the back template text per customer, render to verify layout, export laser-ready SVGs, drop them in the handoff outbox with sequential numbering, and mark items completed. ONLY use when Adam explicitly asks ("fulfill the queue" / "run fulfillment" / "process pending orders" / "process Sarah's order"). Never run autonomously — there is no scheduled trigger, and Etsy orders are not in this pipeline. If a related topic comes up in chat without an explicit ask, do not start the loop.
---

# Achieve Mint — Order Fulfillment

End-to-end loop for turning a pending `FulfillmentItem` into two
laser-ready SVGs (front + back) sitting in Adam's handoff folder. The
backs are unique per order; the fronts usually match an existing
template version exactly.

## What you have

Two env vars are pre-populated:

```bash
TAM_API_URL=https://theachievemint.com/api/v1
TAM_API_TOKEN=axhQjmnfOFsbBixN__vzJI6tzARXEFHdV8A2KyFu7mE
```

(They may differ in the env — always read them from `$TAM_API_URL` /
`$TAM_API_TOKEN` rather than hardcoding.)

Task surface (`POST $TAM_API_URL/tasks` with `Authorization: Bearer
$TAM_API_TOKEN`):

| task_type | when to use |
|---|---|
| `list_pending_fulfillment_items` | Pull the queue at the start of the loop |
| `list_templates` | Browse the catalog when you need to find a matching front design |
| `list_template_versions` | See what versions exist inside a template |
| `inspect_template_version` | Read every text/image/shape element on a version before editing |
| `update_text_area` | **In-place override** of a text area's content (synchronous SVG path regen) |
| `render_template_version` | Get a PNG of the current state to visually verify layout |
| `export_template_version` | Get the laser-ready SVG to drop in the handoff folder |
| `mark_fulfillment_item_completed` | Close the item once both SVGs are in the outbox |

**Critical: in-place override, never clone.** Adam keeps a small set
of stable back-canvas versions and overwrites their text per order.
Do NOT create new versions for each order — just call `update_text_area`
on whichever back canvas applies, export, then move on. Next order
overrides the same text areas again.

## The handoff outbox

Drop final SVGs at `/workspace/extra/handoff_outbox/` inside your
container. That path is bind-mounted to `~/nanoclaw/data/handoff_outbox/`
on the Mini host (a separate sync job delivers from there to Adam's
Mac `~/Desktop/_handoff`).

**File naming**: Adam numbers sequentially across both sides. Read the
current outbox listing, find the highest 3-digit prefix used so far
(`005_back.svg` → 005 is the highest), and start numbering from N+1.
A typical order writes two files in adjacent positions:
```
006_front.svg
007_back.svg
```
Or just one file if the order only has one side. Always 3-digit
zero-padded.

Compute next number:
```bash
HANDOFF=/workspace/extra/handoff_outbox
NEXT=$(ls "$HANDOFF" 2>/dev/null | \
  grep -oE '^[0-9]{3}' | sort -n | tail -1 | awk '{printf "%03d", $1+1}')
NEXT=${NEXT:-001}
```

## The loop (per FulfillmentItem)

1. **Read item context.** From `list_pending_fulfillment_items` you have
   `id`, `title`, `template_id`, `personalization_data` (jsonb with whatever
   the customer entered — could be `name`, `sobriety_date`, `duration`,
   `custom_back_text`, etc.). The shape varies; parse what's there.

2. **Front: match an existing version.**
   - The item's `template_id` is the customer's chosen design. Call
     `list_template_versions` on it.
   - Most templates have multiple versions (e.g. a "mandala" template
     with "Free", "Clean", "Sober", "One Year", "1 Year Sober", "Misc").
     Pick the version whose title best matches the personalization
     (e.g. `duration: "1 year"` + `program: "sober"` → "1 Year Sober").
   - Call `export_template_version` with that version_id. The response
     gives you `svg` (text), `svg_size_bytes`, dimensions.
   - Write the SVG: `echo "$svg" > $HANDOFF/${NEXT}_front.svg`. Bump
     NEXT for the next file.

3. **Back: override text in place.**
   - Find the back-canvas version that matches this design family
     (Adam will tell you which one — typically a known title like
     "Back Canvas — Generic", or look in a "Back Canvases" folder).
   - `inspect_template_version` to see what text areas exist. Each
     has a `name` (e.g. "name_line", "duration_line", "message_top",
     "message_bottom") plus current `default_text`, `font_family`,
     `font_size`, `x`/`y`, `curve_radius` if curved.
   - Map personalization fields onto text-area names with judgment.
     The mapping is up to you — text area `name` is the strongest
     signal, but if it's ambiguous, look at position + font size
     (the prominent one is probably the headline).
   - For each text area you need to change, call `update_text_area`
     with `text_area_id` + `text`. Each call is synchronous — the
     next render reflects the change.

4. **Visual sanity check.**
   - Call `render_template_version` with `width: 800`. Decode the
     `png_base64`, save to `/tmp/check.png`, look at it.
   - Check: does any text overflow the visible coin area? Is anything
     clipped, off-center, or wrapping badly? Does the longest line
     fit comfortably?
   - If something's wrong, fix it: shrink `font_size` on the offending
     text area, shorten the text, adjust `x`/`y`. Re-render. Iterate
     up to ~3 times — if it still doesn't look right, stop and
     iMessage Adam asking for help instead of pushing through.

5. **Export back + write file.**
   - `export_template_version` on the back canvas → `svg` field.
   - Write to `$HANDOFF/${NEXT}_back.svg` (NEXT is now the previous
     front's number + 1).

6. **Mark completed.**
   - `mark_fulfillment_item_completed` with the `fulfillment_item_id`
     and `exported_svg` set to the BACK svg text (the dashboard shows
     the back as the "exported" representation since it's the
     custom one).

7. **Move on.** Loop to the next item. If the queue is empty, send
   Adam a brief iMessage summary (only if you processed at least one
   order — silence is fine for an empty queue).

## Style notes

- **Don't over-edit text-area position fields** (x/y) unless rendering
  actually shows a problem. Default placements are usually right —
  trust the template designer, only nudge when the visual check
  flags it.
- **Don't change `font_family`** unless the customer asked for it.
  Adam picks fonts per template intentionally.
- **Don't touch image areas or shape areas** in this skill — those
  are part of the design, not the personalization. If a request truly
  needs a different icon, stop and ask Adam.
- **Keep the iMessage summary short.** "Processed 3 orders, files 005–010
  in the handoff folder" is plenty. No need to list each customer.

## When something blocks

- Multiple templates could match the front and you can't decide
  → iMessage Adam with the order details + your top 2 candidates,
  wait for him to pick.
- Text won't fit no matter how you scale it → iMessage Adam with the
  current PNG and the issue. Don't ship a clipped design.
- `update_text_area` returns a validation error → stop, log the error,
  iMessage Adam. Don't bypass.

The goal is laser-ready files in the handoff folder with Adam's eye on
anything ambiguous. Better to skip an order and ask than ship one
wrong.
