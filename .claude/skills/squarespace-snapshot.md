---
name: squarespace-snapshot
description: >
  Use when user wants to see the current content/structure of a Squarespace page.
  Runs sq.ts snapshot and presents a human-readable summary of sections and blocks.
---

If the user has not specified a site and page, ask for both before proceeding. Do not guess.

## Run the snapshot

```bash
tsx scripts/sq.ts snapshot --site <id> --page <slug>
```

The output is a JSON object. Parse it to extract sections and blocks.

## Present a human-readable summary

For each section (0-indexed), print:

```
Section 0 — <N> block(s)
  [Text]         "First 80 chars of stripped text content..."
  [Button]       "Label — https://url"
  [Image]        "Alt text or (no alt)"
  [Menu]         "First tab name..."
  [Quote]        "First 80 chars..."
  [Divider]
  [Video]        "YouTube/Vimeo URL or (embedded)"
  [Social Links] "<N> accounts"
  [Map]          "description text or (no description)"
  [Gallery]      "(linked collection)"
  [Unknown type <N>]
```

Strip HTML tags when displaying text snippets. Truncate to 80 characters with `...` if longer.

**Block structure**: the type and value are nested at `block.content.value.type` and `block.content.value.value` — not at the top level of the block object.

## Block type reference

| Type number | Name         | Key fields in `value`                            |
|-------------|--------------|--------------------------------------------------|
| 2           | Text         | `html`                                           |
| 46          | Button       | `label`, `url`                                   |
| 1337        | Image        | `altText`, `assetUrl`                            |
| 18          | Menu         | `menus[]`, `raw`                                 |
| 31          | Quote        | `quote` (HTML), `attribution`                    |
| 47          | Divider      | (no significant fields)                          |
| 8           | Gallery      | `collectionId` (images are in a separate collection, not embedded) |
| 22          | Video        | `url` (YouTube/Vimeo), `html` (embed code)       |
| 54          | Social Links | `accounts[]`, `iconSize`, `iconStyle`            |
| 32          | Map          | `description`, `layout`                          |

Any other type number: display as `[Unknown type <N>]`.

## Error handling

- If the command fails with an auth error or "Could not resolve pageSectionsId", tell the user to run the `squarespace-setup` skill first.
- If the page slug is not found, suggest checking `config/sites.json` for valid page slugs for that site.
- If JSON output is malformed, print the raw output and explain what went wrong.
