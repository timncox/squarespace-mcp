---
name: squarespace-edit
description: >
  Use when user asks to add, edit, remove, or update content on a Squarespace site.
  Executes changes via sq.ts API commands — no browser agent, no pipeline.
---

## Step 1: Identify site and page

Look up the site in `config/sites.json`:

```bash
cat config/sites.json
```

If the user did not specify which site or which page to edit, ask before proceeding. Do not guess or default to any site.

The `--site` flag accepts a client ID, alias, or raw subdomain from `config/sites.json`. The `--page` flag takes a page slug (e.g., `home`, `about`, `contact`).

## Step 2: Snapshot current state

Always snapshot before making changes to understand what exists:

```bash
tsx scripts/sq.ts snapshot --site <id> --page <slug>
```

Note the current section count and section indexes (0-based). You will need these to target the correct sections and to calculate where newly-added sections will land.

If snapshot fails with an auth error or "Could not resolve pageSectionsId", stop and tell the user to run the `squarespace-setup` skill first.

## Step 3: Plan operations

Choose commands based on what the user wants to do.

### Adding new content

Add a blank section first, then add blocks to it:

```bash
tsx scripts/sq.ts add-section --site <id> --page <slug>
```

The new section's index is `(previous section count)` — it is always appended last. Then add blocks to it:

```bash
tsx scripts/sq.ts add-text --site <id> --page <slug> --section <idx> --html "<h2>Title</h2><p>Body.</p>"
tsx scripts/sq.ts add-button --site <id> --page <slug> --section <idx> --label "Book Now" --url "https://example.com"
tsx scripts/sq.ts add-image --site <id> --page <slug> --section <idx> --asset-url "https://..." --alt "Description"
```

`add-section` must run and succeed before any `add-text`/`add-button`/`add-image` targeting that section.

### Modifying existing text

Full replacement (replaces entire block content):

```bash
tsx scripts/sq.ts update-text --site <id> --page <slug> --search "existing text" --html "<p>New content.</p>"
```

Substring replacement (surgical patch, leaves rest of block intact):

```bash
tsx scripts/sq.ts patch-text --site <id> --page <slug> --search "old phrase" --new "new phrase"
```

**Important**: `--search` for `patch-text` identifies what gets replaced, not just which block to find. The matched substring is replaced in-place. Example: if the block says "Hello world!" and you `patch-text --search "world" --new "there"`, the result is "Hello there!" — the rest of the block text is preserved.

Prefer `patch-text` for small changes. Use `update-text` when replacing the entire block.

### Removing content

```bash
tsx scripts/sq.ts remove-block --site <id> --page <slug> --search "text in block to remove"
```

`--search` matches case-insensitively against block text content.

### Reordering sections

```bash
tsx scripts/sq.ts move-section --site <id> --page <slug> --search "text in section" --direction up|down
```

`--search` identifies the section by matching text within it. Run multiple times to move a section more than one position.

### Styling a section

```bash
tsx scripts/sq.ts section-style --site <id> --page <slug> --search "text in section" [--theme dark|light|white|black] [--height small|medium|large|full]
```

`--search` identifies the section by matching text content within it.

## Step 4: Execute operations

Run commands one at a time via Bash. After each command, check the output for `"success": true` before continuing.

If a command returns `"success": false`, read the error message and decide:
- Auth error → stop, tell user to run `squarespace-setup`
- Block not found → check that `--search` text matches actual block content (use snapshot to confirm)
- Section index out of range → re-snapshot to get current section count
- Other error → report the full error to the user before proceeding

Do not blindly continue after a failure. Each operation depends on the state left by previous ones.

## Step 5: Verify

After all operations, run another snapshot:

```bash
tsx scripts/sq.ts snapshot --site <id> --page <slug>
```

Confirm:
- Section count changed as expected (if sections were added/removed)
- Block content matches what was requested
- No unexpected content was lost

Report the before/after comparison to the user.

## Key rules

- API calls take ~200ms each. Always prefer this over the browser agent.
- Section indexes are 0-based and reflect state AFTER all preceding operations in the same session. Re-snapshot if unsure.
- HTML for `--html` must be valid HTML. Examples: `<h2>Heading</h2><p>Paragraph.</p>`, `<ul><li>Item</li></ul>`.
- `--search` for `update-text`, `patch-text`, `remove-block`, and `section-style` is case-insensitive and matches against stripped text content (no HTML tags).
- For private or trial sites where snapshot fails, instruct the user to run `squarespace-setup` and obtain `--psid` and `--colid` values from the editor URL, then append them to each command. For sites with pre-seeded page ID cache, no flags are needed.
- Special characters in `--search` or `--html`: use `$'...'` bash quoting for unicode (e.g., `$'Let\u2019s'` for curly apostrophe). Squarespace content often contains curly quotes and em dashes.
- If the user asks to "add a section with a heading and body", that is two operations: `add-section` + `add-text`. Plan the full sequence before executing.
