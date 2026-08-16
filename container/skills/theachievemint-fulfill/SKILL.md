---
name: theachievemint-fulfill
description: Turn a custom Achieve Mint or Etsy coin order into engrave-ready SVGs on theachievemint.com and queue them for Adam to cut. Use when a new Etsy "You made a sale" email arrives for a personalizable coin, when Adam pastes or screenshots an order, or when he asks to build/queue/fulfill an order. Building and queueing are safe to do on your own; cutting, shipping, and replying to customers are not.
---

# Achieve Mint — build a custom coin and queue it

Take an order, build the coin on theachievemint.com prod, and save the
export onto the **engraving queue**. Adam works the queue and cuts.

**The handoff folder is gone.** An earlier version of this skill wrote
SVGs to `/workspace/extra/handoff_outbox/` with sequential numbering.
Don't. Nothing you produce leaves the container as a file any more — it
goes to the queue and shows up at
`https://theachievemint.com/admin/engraving_queue`.

## Credentials

```bash
TAM=https://theachievemint.com/api/v1     # or $TAM_API_URL
TAMK=$TAM_API_TOKEN                        # bearer; same key as the content API
# Etsy sale emails live in hwm_app, not Gmail — see the hwm-api skill:
#   $HWM_API_URL / $HWM_API_TOKEN
```

Read tokens from the environment; never paste them into chat.

---

## 1. Get the order

### Etsy (most custom orders)

Sale notifications land in **hwm_app**, from `transaction@etsy.com`,
subject `You made a sale on Etsy - Ship by ... - [$X, Order #N]`.

```bash
curl -s -H "Authorization: Bearer $HWM_API_TOKEN" \
  "$HWM_API_URL/emails/search?query=made%20a%20sale&limit=10"
curl -s -H "Authorization: Bearer $HWM_API_TOKEN" "$HWM_API_URL/emails/EMAIL_ID"
```

The body carries everything you need to build:

```
Item: Any Year Mandala | Custom Personalizable Silver Sobriety Coin | ...
With or without display case: Coin, small stand
Personalization: FRONT: TWO YEARS FREE / BACK: 08.20.26
You are the strongest and bravest human I know, my Person. Love, your Person
Quantity: 1
```

Three things to know about that email:

- **Personalization is multi-line.** It runs from the `Personalization:`
  label down to the `Quantity:` line. Take all of it — the back message
  is usually on the lines *after* the label, and stopping at the first
  newline silently drops half the coin.
- **There is no SKU.** Use the item title; it names the design ("Any Year
  Mandala", "Pier at Night", "Flying Hawk Day and Night").
- **It is a point-in-time snapshot.** Customers send changes afterwards as
  Etsy conversations ("could you add the word *still*?"). Check messages
  for the order before building. If Adam already replied agreeing to a
  change, the change wins over the email.

Only open Etsy in the browser for something the email doesn't have — a
later message, a gift note, a personalization that looks truncated. The
link is in the email (`etsy.com/your/orders/<n>`). Use the host-browser
skill: that Chrome is Adam's real logged-in session and it is
**read-only**. Never click anything that changes the order.

### The Achieve Mint

TAM orders are in the site's own admin. Use the order number
(`TAM-2026...`) as `order_ref` and also set `order_id`.

---

## 2. Open the job first

Do this **before** building, so a half-finished order is still visible if
you stop or fail.

```bash
curl -s -X POST -H "Authorization: Bearer $TAMK" -H "Content-Type: application/json" \
  -d '{"channel":"etsy","order_ref":"4133361963","customer_name":"Megan Leonard",
       "item_title":"Pier at Night | Custom Personalizable Silver Sobriety Coin",
       "variation":"Coin only","ship_by":"2026-08-07",
       "personalization":"Front: 2 months sober\nBack: One day at a time. 114"}' \
  "$TAM/engraving_jobs"
```

Safe to re-run — it is idempotent on `(channel, order_ref)` and updates
rather than duplicating. Put anything Adam needs to know in `notes`: a
change request, an ambiguity you resolved, a typo you fixed.

---

## 2b. Which kind of coin is this?

Three kinds come through, and only one of them is a template job. Decide
before you go looking for a design, because two of them have no design to
find and looking anyway is how the wrong coin gets built.

**Fully custom** — SKU `TAM-FCU-SCOI-2C`, or a title beginning "Fully
Custom Sobriety Coin". Adam draws these in Accomplice; there is no
template and there never will be. Create the job with
`"fully_custom": true` and **stop there**. Do not pick a template that
looks close. The queue shows it as waiting on artwork, Adam uploads the
SVG, and that is the whole flow.

```bash
curl -s -X POST -H "Authorization: Bearer $TAMK" -H "Content-Type: application/json" \
  -d '{"channel":"etsy","order_ref":"4138341893","customer_name":"Zoe Black",
       "item_title":"Fully Custom Sobriety Coin | Your Design, Your Words",
       "sku":"TAM-FCU-SCOI-2C","fully_custom":true,"ship_by":"2026-08-14",
       "personalization":"Front: One Day at a Time ... / Back: ..."}' \
  "$TAM/engraving_jobs"
```

Put the whole personalization on the job even though nothing builds from
it — it is the brief Adam draws from. If the customer attached pictures,
say so in `notes`; TAM orders carry them as `front_image_image_id` /
`back_image_image_id` on the order item, and Etsy ones arrive as
attachments or messages.

**A token with a personalized message** — SKU ending `-TOK`, title
"... sobriety token", and a `Personalized message on back` line. The
front is stock. Build **only the back**, from the **Token** template
(one template, one version, a single centred text layer). Short messages:
"Proud of you!", a name, a date. Set that layer to the customer's words
and snapshot it as the back. A token with no personalized message needs
no engraving at all — don't make a job for it.

**Everything else** is a template coin: carry on to section 3.

A plain stock coin with no personalization (`TAM-SOB-04YR-COI` and the
like, no `Personalization:` line) is picked off a shelf. It does not
belong in this queue.

---

## 3. Find the template

```bash
curl -s -H "Authorization: Bearer $TAMK" "$TAM/templates/folders"
curl -s -H "Authorization: Bearer $TAMK" "$TAM/templates?folder=Starry%20Night"
curl -s -H "Authorization: Bearer $TAMK" "$TAM/versions/VERSION_ID?geometry=true"
curl -s -H "Authorization: Bearer $TAMK" "$TAM/versions/VERSION_ID/render?width=700" -o /tmp/coin.png
```

Match on the **item title**, not the SKU — product names and template
names differ. Confirm by rendering a candidate and comparing it with the
listing thumbnail rather than trusting the name.

### Year tiers — the rule that matters

Tier folders ("Any year mandala", "Starry Night") hold one template per
milestone. Some designs carry a **rim breakdown** — `24 Months • 104
Weeks • 730 Days • …` — hand-typed per year and baked into the layer.

**Never fulfil one year on another year's template when the rim carries a
breakdown.** Overwriting the centre does not fix the rim, and you would
engrave the wrong month/week/day counts. If the tier doesn't exist that
is work to do, not a substitution: **stop and tell Adam a new tier must
be created.** Creating a Template still needs a prod runner — the API can
create layers, but not templates or versions.

`GET /skus/:sku/design` and `POST /skus/:sku/plan_text` encode this when a
SKU is known; the resolver answers `must_create` rather than borrowing.
Believe it.

For designs with no breakdown (milestone words only), borrowing a tier
whose label is the **same character length** is fine — the arc already fits.

---

## 4. Build it

**Templates are scratchpads. Overwrite text in place; never clone.** Adam
reuses the same templates every order and keeps no copies, so replacing
existing text is always correct and never needs permission.

```bash
curl -s -X PATCH -H "Authorization: Bearer $TAMK" -H "Content-Type: application/json" \
  -d '{"text":"Two\nYears\nFree","font_size":44,"line_height":1.1}' "$TAM/layers/LAYER_ID"
```

### Centring

- **Straight text** — `POST $TAM/layers/:id/center` with
  `{"vertical":"optical"}`. It converges.
- **Curved text** (`curved_top` / `curved_bottom` / `circle`) — **do not
  call center.** `LayerGeometry` cannot measure curved layers: `measured`
  comes back `0x0`, and centring on that has thrown `x` to −887 and
  wrecked a template. Centre it by measuring the render instead: render
  the version, PATCH the text to `"."`, render again, diff the two
  images — the changed-pixel box is the glyphs. Then
  `new_x = x + (250 − ink_centre_x)`, two or three passes to converge.
  Flatten renders with `-background white`; they are ink-on-transparent
  and compositing onto black gives a silently empty diff.

### Sizing — fill the medallion

Adam's standing correction: **use the biggest font that fits.** Only go
small when nothing else will work.

- The binding constraint is the **longest line**, so re-wrapping into
  more, shorter lines usually lets the type get *bigger*. Adding a line
  is a win, not a compromise.
- Break mid-phrase if it shortens the longest line. Legible size beats
  tidy phrasing.
- Width budget depends on the design: a plain back takes ~380 canvas
  units; a back bounded by a rim or inner circle is limited by that
  circle — measure it (moon ≈ 194, mandala ≈ 168 radius).
- Decorative art inside the medallion (moons, stars) is a constraint the
  geometry can't see. **Zoom the render at the tight edge** before
  accepting a fit.

### Look at it

Render at `width=700` or more and actually view the PNG before saving.
Check for overflow, collision with artwork, a gap or collision at a ring's
seam, clipped descenders. Iterate up to about three times; if it still
isn't right, stop and ask rather than queueing a bad coin.

---

## 5. Save to the queue

One saved version per side. This **snapshots the export** — the bytes are
frozen, so a later order overwriting the scratchpad cannot change what
Adam cuts.

```bash
curl -s -X POST -H "Authorization: Bearer $TAMK" -H "Content-Type: application/json" \
  -d '{"version_id":"TEMPLATE_VERSION_UUID","label":"Front"}' \
  "$TAM/engraving_jobs/JOB_ID/saved_versions"
```

Use `{"svg":"...","filename":"..."}` only for something not built from a
template. Deleting a saved version removes just that file — the template
is untouched — so a bad save is cheap to redo.

Confirm `"ready": true` on the job when you're done.

---

## 6. Report

One short iMessage per batch: what you queued, and anything Adam must
decide.

> Queued 3 — Etsy 4133361963, 4133113853, TAM-20260801-TF9D3A.
> 4132530064 needs a 48-year Starry Night tier created first.

Don't list every field. Silence is fine when there was nothing to do.

---

## Stop and ask when

- The year tier doesn't exist on a design whose rim carries a breakdown.
- Two designs could plausibly match the item title.
- The text won't fit at a legible size however you wrap it.
- The personalization is ambiguous, contradictory, or looks truncated.
- The customer asked for a change and you can't tell whether Adam agreed.
- A PATCH returns a validation error. Don't work around it.

## Never

- Write files to a handoff folder — that flow is retired.
- Clone a template or version to "preserve" the old text.
- Call `center` on curved text.
- Message the customer, mark anything shipped, or touch prices.
- Click anything in Adam's Etsy session. It is read-only.
