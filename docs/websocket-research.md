# Squarespace Editor Content Save Protocol — Research Findings

**Date:** February 2026
**Status:** Research complete
**Conclusion:** Squarespace does NOT use WebSockets for content saving. It uses standard REST/HTTP POST requests.

---

## Executive Summary

The hypothesis was that Squarespace saves content (text blocks, Custom CSS) via WebSocket, and that we could build a direct client to bypass browser UI automation. After thorough investigation — including Squarespace's engineering blog, reverse-engineering community projects, and codebase analysis — the finding is:

**Squarespace's editor uses standard HTTP REST endpoints for all content saves, not WebSockets.**

The original note in `api-capabilities.md` ("Content saves (text, CSS) go through WebSocket, NOT REST — invisible to HTTP capture") was incorrect. The saves were "invisible" because:

1. Service Workers intercepted the requests (hidden from Playwright's `page.on('request')`)
2. The `NetworkCapture` class only matches `/api/` URL patterns by default — the save endpoints may use different URL paths
3. The `discover-api.ts` script's `editText` action may not have waited long enough or captured broadly enough

## Evidence

### Squarespace Engineering Blog (Primary Source)

In ["A Better Way to Upload Images" (2022)](https://engineering.squarespace.com/blog/2022/a-better-way-to-upload-images), Squarespace engineers explicitly state:

> "The cost of keeping a WebSocket connection alive for a long time didn't justify the project needs."

They chose a **REST polling job system** instead:

> "The server maintains long running job instances with some state variables, while clients communicate by posting and fetching state updates to that long running job."

> "Using standard REST APIs reduces cost of implementation."

This was for their mobile-to-desktop image upload feature, but the design philosophy applies across the editor — they prefer stateless REST over persistent connections.

### Reverse-Engineering Community

No public evidence of WebSocket usage exists:

- **`node-squarespace-middleware`** (kitajchuk) — reverse-engineered the internal API for local dev. All endpoints are REST: `/api/auth/Login/`, `/api/commondata/GetSiteLayout/`, `/api/block-fields/{blockId}`, etc.
- **`SquarespaceWebsites Tools`** Chrome extension — uses undocumented internal REST APIs (closed-source, but the developer warns it can corrupt site content)
- **Zero GitHub repos, blog posts, or forum threads** document WebSocket connections in the Squarespace editor

### Technology Stack

- Backend: Java/Scala on JVM (Netty-based proxy)
- Frontend/Editor: React (migrated from Backbone.js/CoffeeScript)
- No known use of Socket.IO, SockJS, Phoenix Channels, SignalR, or raw WebSocket protocols
- No collaborative editing protocols (OT, CRDTs) — the editor is single-user

## What the Editor Actually Uses

### Authentication

All internal API requests require:
1. **Session cookies**: `SS_SESSION_ID`, `SS_ANALYTICS_ID`, etc.
2. **Crumb token**: A CSRF token from the `crumb` cookie or `Static.SQUARESPACE_CONTEXT.crumb` JS variable
3. Crumb is passed as a query parameter (`?crumb=VALUE`) on all mutating requests

### Known Internal Endpoints

| Endpoint | Method | Purpose | Source |
|----------|--------|---------|--------|
| `/api/auth/Login/` | POST | Session login | node-squarespace-middleware |
| `/api/commondata/GetSiteLayout/` | GET | Site layout data | node-squarespace-middleware |
| `/api/commondata/GetCollections/` | GET | All collections | node-squarespace-middleware |
| `/api/commondata/GetCollection/?collectionId={id}` | GET | Single collection | node-squarespace-middleware |
| `/api/block-fields/{blockId}` | GET | Block field data | node-squarespace-middleware |
| `/api/widget/GetWidgetRendering/` | POST | Render widget HTML | node-squarespace-middleware |
| `/api/config/SaveInjectionSettings?crumb=` | POST | Save code injection | Our API discovery |
| `?format=json-pretty` | GET | Page JSON (any page URL) | Our SiteReader |

### Discovered Save Endpoints (Feb 21, 2026)

| Endpoint | Method | Purpose | Trigger |
|----------|--------|---------|---------|
| `/api/page-sections/{pageId}/collection/{collectionId}` | PUT | **Save ALL page content** (sections + blocks + text + layout) | Cmd+S |
| `/api/site-header-footer` | PUT | Save header/footer configuration | Cmd+S |
| `/api/v1/guidance/task/completion` | POST | Mark onboarding tasks complete | Cmd+S (side effect) |
| `/api/site-preview/v1/screenshots/request` | POST | Regenerate site preview screenshots | Cmd+S (side effect) |

### Still Unknown Endpoints

| What | Expected Method | Notes |
|------|----------------|-------|
| **Save Custom CSS** | POST/PUT | Need to capture via `--action css` mode |
| **Save page SEO settings** | POST/PUT | Title, slug, description — may use a different endpoint |

## Capture Script Results (Feb 21, 2026)

### Run 5 — ENDPOINTS DISCOVERED (successful)

After fixing the text entry mechanism (using `clickThroughOverlay` + `dblclickThroughOverlay` from `editor-actions.ts` instead of raw coordinate clicks), text entry was **confirmed** and save endpoints were captured on **Cmd+S**.

#### Save Endpoints Discovered

| Endpoint | Method | Purpose | Body Size |
|----------|--------|---------|-----------|
| `/api/page-sections/{pageId}/collection/{collectionId}` | PUT | **Save page content** (sections, blocks, text, layout) | ~13KB |
| `/api/site-header-footer` | PUT | Save header/footer configuration | ~8.6KB |
| `/api/v1/guidance/task/completion` | POST | Mark onboarding tasks complete (side effect) | ~30-45B |
| `/api/site-preview/v1/screenshots/request` | POST | Trigger site preview screenshot regeneration | 0B |

**Key finding:** `PUT /api/page-sections/{pageId}/collection/{collectionId}` is the **primary content save endpoint**. It sends the entire `sections` array for the page — all section data including:
- Section name, ID, styles, background images
- Fluid Engine block layout data
- Block content (text, images, etc.)
- Video settings, overlay opacity, alignment

**Save trigger:** Cmd+S (keyboard shortcut). No autosave was observed during typing or blur.

**Request flow on Cmd+S:**
1. `PUT /api/page-sections/{pageId}/collection/{collectionId}` → 200 (content save)
2. `PUT /api/site-header-footer` → 200 (header/footer, even when unchanged)
3. `POST /api/v1/guidance/task/completion` × 3 → 201 (onboarding markers)
4. `POST /api/site-preview/v1/screenshots/request` → 200 (screenshot regen)

**IDs from captured URL:**
- Page ID: `6993497ab23b0453e46b65aa` (the "home" page)
- Collection ID: `6993497ab23b0453e46b65ab`
- These IDs are available from `?format=json-pretty` or `/api/commondata/GetCollections/`

#### What intercepted the requests

The save requests were XHR calls from the **iframe** (`sqs-site-frame`), captured by:
- `XMLHttpRequest.send` hook injected into the iframe
- CDP `Fetch.enable` with `*squarespace.com*` pattern
- `context.route('**/*')` (route-level interception)
- Standard `page.on('request')` did NOT see them (iframe-origin requests)

### Previous Runs 1-4 (failed — text entry broken)

Runs 1-4 all showed zero save requests because the text entry mechanism itself was broken:
- Double-clicking on hardcoded iframe coordinates didn't open the text editor
- `page.keyboard.type('CAPTURE_TEST')` typed into nothing
- Since no edit occurred, no save request was generated

**Root cause:** The script needed to use `clickThroughOverlay()` (from `editor-actions.ts`) which handles the `#sqs-editing-overlay` interception layer and scrolls elements into view before calculating coordinates.

### CSS Save Endpoint (still needs capture)

The CSS save endpoint was not captured in this run (text-only mode). It should be discoverable by:
1. Navigating to `/config/design/custom-css`
2. Typing in the CodeMirror editor
3. Pressing Cmd+S
4. Expected endpoint: likely `POST /api/config/SaveCustomCSS?crumb=...` or similar

## Feasibility Assessment

### Direct HTTP Content Save Client — CONFIRMED FEASIBLE

Now that the save endpoint is known, building a `ContentSaveClient` is straightforward:

**Architecture:**
```
ContentSaveClient
├── getPageSections(pageId, collectionId)  → GET current sections JSON
├── updateTextBlock(pageId, collectionId, blockId, newText)
│   └── Modifies the text block in the sections array, PUTs the whole thing
├── updateCustomCSS(css) → PUT to CSS endpoint (needs capture)
└── saveSiteHeaderFooter(headerConfig) → PUT /api/site-header-footer
```

**Pros:**
- Single HTTP PUT replaces 10+ Playwright steps for text edits
- ~100ms vs ~10-30s for browser automation
- No UI timing issues, no click targeting failures
- Can batch multiple text changes into one PUT
- Session cookies already managed by `BrowserManager`

**Cons:**
- Sends the ENTIRE sections array (not surgical block-level updates)
- Need page/collection IDs (available from `?format=json-pretty`)
- Need the `crumb` CSRF token (available from cookies or `Static.SQUARESPACE_CONTEXT`)
- Undocumented API — could break with Squarespace updates

**Best use cases for direct saves:**
- Editing existing text block content
- Updating Custom CSS
- Changing page SEO fields
- Modifying code injection settings (already have this via `/api/config/SaveInjectionSettings`)

**Keep browser automation for:**
- Adding/removing blocks and sections
- Template selection
- Image uploads (already have `MediaUploadClient` as alternative)
- Any operation requiring visual verification

### Recommended Next Steps

1. ~~Run capture script to discover save endpoints~~ **DONE**
2. **Capture CSS save endpoint** — run `--action css` mode
3. **Build a `ContentSaveClient`** similar to `MediaUploadClient`:
   - GET current page sections via `/api/page-sections/{pageId}/collection/{collectionId}` or `?format=json-pretty`
   - Modify the target block's content in the sections JSON
   - PUT the modified sections back
   - Include `crumb` CSRF token
4. **Integrate into browser agent** as a fast path for text edits

## Sources

- [A Better Way to Upload Images — Squarespace Engineering (2022)](https://engineering.squarespace.com/blog/2022/a-better-way-to-upload-images)
- [Developing Fluid Engine — Squarespace Engineering (2022)](https://engineering.squarespace.com/blog/2022/developing-fluid-engine)
- [The cookies Squarespace uses — Squarespace Help Center](https://support.squarespace.com/hc/en-us/articles/360001264507)
- [node-squarespace-middleware — GitHub (kitajchuk)](https://github.com/kitajchuk/node-squarespace-middleware)
- [node-squarespace-server — GitHub](https://github.com/NodeSquarespace/node-squarespace-server)
- [Style Editor — Squarespace Developers](https://developers.squarespace.com/style-editor)
