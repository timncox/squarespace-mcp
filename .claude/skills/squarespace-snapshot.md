---
name: squarespace-snapshot
description: >
  Use when user wants to see the current content/structure of a Squarespace page.
  Runs sq.ts snapshot and presents a human-readable summary of sections and blocks.
---

If the user has not specified a site and page, ask for both before proceeding. Do not guess.

## Companion Commands

Before taking a snapshot, you can list all pages on a site:

```bash
tsx scripts/sq.ts list-pages --site <id>
```

This calls `listCollections()` and shows all pages, blogs, galleries, stores with their slugs and types. Useful for finding the correct `--page` slug.

To see the navigation structure (page ordering, folders, hidden pages):

```bash
tsx scripts/sq.ts navigation --site <id>
```

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
| 46   | Button (legacy)| `label`, `url`                                                 |
| 47   | Divider        | (no significant fields)                                        |
| 51   | Newsletter     | `headline`, `description`, `buttonText`                        |
| 54   | Social Links   | `accounts[]`, `iconSize`, `iconStyle`                          |
| 69   | Accordion      | `title`, `paragraphs[]`                                        |
| 70   | Marquee        | `text`, `speed`                                                |
| 1337 | Button (new)   | `buttonText`, `buttonLink`, `buttonSize`, `buttonAlignment`, `buttonStyle`, `buttonVariant` (definitionName: `website.components.button`) |
| 1337 | Image          | `altText`, `assetUrl`                                          |
| 1337 | Code           | `wysiwyg.engine === 'code'` (distinguishes from Image)         |
| 1337 | Form           | `buttonVariant` field present (distinguishes from Image/Code)  |

**Note**: Types 1337 (Button), 1337 (Image), 1337 (Code), and 1337 (Form) share the same type number. Distinguish by: Button has `definitionName === 'website.components.button'`; Code has `wysiwyg.engine === 'code'`; Form has `buttonVariant` field but no `definitionName`; Image is the default.

Any other type number: display as `[Unknown type <N>]`.

## Error handling

- If the command fails with an auth error or "Could not resolve pageSectionsId", tell the user to run the `squarespace-setup` skill first.
- If the page slug is not found, suggest checking `config/sites.json` for valid page slugs for that site.
- If JSON output is malformed, print the raw output and explain what went wrong.

## Link validation

After taking a snapshot, you can audit all links on the page using the `validate-links` CLI command:

```bash
tsx scripts/sq.ts validate-links --site <id> --page <slug>
```

This calls `extractAndValidateLinks()` on the page's sections. It extracts all links from text blocks (HTML `<a>` tags), button blocks (`url` field), and image blocks (`linkTo` field), then checks each one for validity (HTTP status, redirects, broken links). The output is a JSON summary with all extracted links and their validation status.

Use this as a post-snapshot audit to catch broken links, missing URLs, or redirect chains before reporting page status to the user.
