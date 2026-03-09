# Planning

## Remaining TODO

- [ ] Discover block type numbers: Video (external/YouTube — type 50 suspected), Calendar, Pricing Plan, Product
- [ ] Audio block (type 41) — add/update MCP tools. Needs `MediaUploadClient` for audio files.
- [ ] Chart block (type 62) — add/update MCP tools. Full data structure needs deeper capture.
- [ ] Page Link block (type 12) — add/update MCP tools. Simple: `{ linkTitle, linkTarget, newWindow }`.
- [ ] Shape block (type 1337 variant) — decorative, low priority

## Reference: Section Style API — Confirmed Fields (Mar 2026)

Live discovery on grey-yellow-hbxc test-page. Captured via `scripts/discover-section-style.ts`.

### Section `styles` Object (at `section.styles.*`)

| Field | API Format | Notes |
|-------|-----------|-------|
| `sectionTheme` | `"white"` \| `"light"` \| `"dark"` \| `"black"` \| `""` | Lowercase. Controls coordinated background + text + button colors. |
| `sectionHeight` | `"section-height--small"` \| `"--medium"` \| `"--large"` \| `"--full"` | CSS class format |
| `contentWidth` | `"content-width--wide"` \| `"--inset"` \| `"--full"` | CSS class format |
| `verticalAlignment` | `"vertical-alignment--top"` \| `"--middle"` \| `"--bottom"` | CSS class format |
| `horizontalAlignment` | `"horizontal-alignment--left"` \| `"--center"` \| `"--right"` | CSS class format (not yet in SectionStyleOptions) |
| `backgroundWidth` | `"background-width--full-bleed"` | CSS class format (not yet wired) |
| `imageOverlayOpacity` | `0.15` (number 0–1) | Background image overlay |
| `sectionAnimation` | `"none"` \| `"...?"` | Scroll animation |
| `backgroundMode` | `"image"` \| `"color"` \| `"video"` | What background to show |
| `customSectionHeight` | `1` – `100` (number) | Pixel/% custom height when `sectionHeight` has custom value |
| `customContentWidth` | `0` – `100` (number) | Percent when content width is custom |

### Section `divider` Object (at `section.divider` — top-level, NOT in `styles`)

```json
{
  "enabled": true,
  "type": "pointed",
  "width": { "unit": "vw", "value": 100 },
  "height": { "unit": "vw", "value": 12 },
  "isFlipX": true,
  "isFlipY": false,
  "offset": { "unit": "px", "value": 0 },
  "stroke": {
    "style": "solid",
    "color": { "type": "THEME_COLOR" },
    "thickness": { "unit": "px", "value": 15 },
    "dashLength": { "unit": "px", "value": 5 },
    "gapLength": { "unit": "px", "value": 15 },
    "linecap": "square"
  }
}
```

When disabled: `{ "enabled": false }` (no other fields).

**Known divider `type` values** (confirmed): `"pointed"`. Expected others: `"wave"`, `"slant"`, `"brush"`, `"paint"`.

### Unconfirmed / Not Yet Discovered

- `backgroundColor`, `paddingTop`, `paddingBottom`, `blockSpacing` — NOT found in API data. Not settable via Content Save API.
- Section animation values (other than `"none"`)
- Other divider shape type values
