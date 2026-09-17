---
name: theachievemint-etsy-listings
description: Keep The Achieve Mint's Etsy shop matching theachievemint.com. Use when a message starts with [ETSY LISTINGS], when Adam asks to sync listings to Etsy, or when a new TAM product needs an Etsy listing. TAM is the source of truth; Etsy is a copy. First bring every behind listing up to TAM, and only then create listings for products that have none.
---

# Achieve Mint — Etsy matches TAM

theachievemint.com's product record is the source of truth for every Etsy
listing: title, description, personalization questions, prices, tags,
pictures. Etsy is a copy of it. You carry changes from TAM to Etsy by hand
in Adam's Chrome on the Mini (host-screen skill) and report back to TAM.

Two rules above everything else:

1. **TAM wins. Never the other way.** If Etsy says something different from
   TAM, Etsy is out of date. Replace it. Never edit a TAM product to match
   Etsy, never keep Etsy's wording because it "looks newer", never merge.
   If TAM's text looks wrong to you, stop and tell Adam; do not fix it
   either place.
2. **Behind first, new second.** Do not create a single new listing while
   any existing listing is behind. `list_etsy_listings filter=behind` must
   come back empty before `filter=unmapped` gets touched.

## Credentials

```bash
TAM=https://theachievemint.com/api/v1     # or $TAM_API_URL
TAMK=$TAM_API_TOKEN
run_task() { curl -sS -X POST "$TAM/tasks" -H "Authorization: Bearer $TAMK" \
  -H "Content-Type: application/json" -d "{\"task_type\":\"$1\",\"task_data\":$2}"; }
```

## The three tasks

- `list_etsy_listings` `{"filter":"behind"}` / `{"filter":"unmapped"}` /
  `{"find_product_handle":"..."}`. Each product row carries `listings`
  (with `edit_url`, `description_behind`, `personalization_behind`),
  `description` (the EXACT text for Etsy, "How to order" block included),
  `personalization_fields` (`label`, `hint`, `max_chars`, `required`),
  `variants` (title, price, sku), `images` (url + alt, in order), `tags`,
  and for an unmapped product a `sibling_listing_id` to duplicate.
- `record_etsy_listing` `{"listing_id":N,"find_product_handle":"...","etsy_title":"...","state":"active"}`
  the moment a new listing exists on Etsy, even before it is finished.
- `mark_etsy_listing_synced` `{"listing_id":N,"description":true,"personalization":true}`
  right after Etsy's Publish/Save succeeds. Only claim what was saved.

## Part 1 — sync what is behind

For each product in `filter=behind`, for each of its listings:

1. Open `edit_url` on the Mini's screen (host-screen). Screenshot before
   you act, every time.
2. If `description_behind`: select all of Etsy's description and replace it
   with TAM's `description`, verbatim. It is plain text already. Do not
   shorten it, do not keep a paragraph of Etsy's.
3. If `personalization_behind`: make Etsy's personalization form carry
   exactly `personalization_fields`, in order, label / hint / character
   limit / required as given. Remove any question TAM does not list. Shapes
   you will see:
   - RIM ONLY any-year coins (Starry Night, Cardinal, Hummingbird, Bluejay,
     Clockwork): "Time for front border", "Back Personalization", "Coin
     blank color". No "Front Personalization" on these.
   - RIM + MIDDLE TEXT (Mandala, Moons Phases): all four, Front included.
   - Single sobriety tokens: the one back-message question is the paid
     "+$5" personalization, optional, 30 chars. Keep it priced at $5.
   - Fully custom, premade coin sets: no questions.
4. Publish. Screenshot to confirm it took.
5. `mark_etsy_listing_synced` with `description` and/or `personalization`
   set to what you actually saved.

Work in order, one listing at a time. Every 10 listings send a short
progress line with `send_message` (how many done, how many left, anything
odd) and KEEP GOING. Your final reply ends the run, so do not reply until
Part 1 and Part 2 are both finished or you are blocked; a progress report
that ends your turn stops the sync until someone pokes you again (that is
what happened on 2026-09-16, ten listings at a time).
If Etsy throws a page you don't recognise, screenshot it, stop that
listing, say so, and move to the next.

When `filter=behind` returns `count: 0`, Part 1 is done. Say so.

## Part 2 — create listings for products with none

Only after Part 1 is clean. For each product in `filter=unmapped`:

1. In Etsy's listing manager, find `sibling_listing_id` and use Etsy's
   **Copy** on it. The copy carries the category, shipping profile,
   production partner, return policy and section. Record the new listing
   id with `record_etsy_listing` (`state: "draft"`) as soon as the copy
   exists, so a half-finished listing is never lost.
2. Title: TAM's `title`, then the same "| Custom Personalizable ... |"
   tail the sibling's Etsy title uses. Keep it under Etsy's 140 characters.
3. Description: TAM's `description`, verbatim.
4. Variants and prices: exactly `variants`. Delete the sibling's variants
   that TAM does not list.
5. Personalization: `personalization_fields`, as in Part 1.
6. Tags: `tags`, all of them, trimmed to Etsy's 13 if TAM lists more.
7. Pictures, in the order given. Download them into
   `/workspace/extra/handoff_outbox/etsy/<handle>/01.jpg, 02.jpg, ...`
   (that folder is `~/nanoclaw/data/handoff_outbox/etsy/<handle>/` on the
   Mini). In Etsy's photo uploader, open the file dialog, press
   Cmd+Shift+G, type that Mini path, and pick the files. Delete every
   picture the copy inherited from the sibling first. Use the `alt`
   text TAM gives for each picture.
   The pouch picture TAM hands you shows the soft pouch alone. Never
   upload a picture that shows the gift box or the message card, and
   never write "gift box" anywhere on Etsy; that is a site-only offer.
8. Publish. Then `record_etsy_listing` again with `state: "active"` and the
   final `etsy_title`, then `mark_etsy_listing_synced` with both true.

Report one line per listing created: title, listing id, anything you
could not do (an upload that failed, a variant Etsy refused).

## What not to do

- Do not touch a listing that is not behind and not unmapped.
- Do not renew, deactivate, or delete listings.
- Do not change prices on an existing listing unless the message asks.
- Do not text Adam. Your reply here is the report.
