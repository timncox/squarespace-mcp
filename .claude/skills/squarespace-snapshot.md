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

## Block type reference (Fluid Engine)

| Type | Name           | Key fields in `value`                                          |
|------|----------------|----------------------------------------------------------------|
| 2    | Text           | `html`                                                         |
| 8    | Gallery        | `collectionId` (images in separate collection, not embedded)   |
| 18   | Menu           | `menus[]`, `raw`, `menuStyle`, `currencySymbol`                |
| 22   | Embed          | `html` (embed code), `url`                                     |
| 31   | Quote          | `quote` (HTML), `attribution`                                  |
| 32   | Video          | `url` (YouTube/Vimeo), `html` (embed code)                     |
| 46   | Button         | `label`, `url`                                                 |
| 47   | Divider        | (no significant fields)                                        |
| 51   | Newsletter     | `headline`, `description`, `buttonText`                        |
| 54   | Social Links   | `accounts[]`, `iconSize`, `iconStyle`                          |
| 69   | Accordion      | `title`, `paragraphs[]`                                        |
| 70   | Marquee        | `text`, `speed`                                                |
| 1337 | Image          | `altText`, `assetUrl`                                          |
| 1337 | Code           | `wysiwyg.engine === 'code'` (distinguishes from Image)         |
| 1337 | Form           | `buttonVariant` field present (distinguishes from Image/Code)  |

**Note**: Types 1337 (Image), 1337 (Code), and 1337 (Form) share the same type number. Distinguish by: Code has `wysiwyg.engine === 'code'`; Form has `buttonVariant` field; Image is the default.

Any other type number: display as `[Unknown type <N>]`.

## Error handling

- If the command fails with an auth error or "Could not resolve pageSectionsId", tell the user to run the `squarespace-setup` skill first.
- If the page slug is not found, suggest checking `config/sites.json` for valid page slugs for that site.
- If JSON output is malformed, print the raw output and explain what went wrong.
