# Damask Protocol Analysis

**Date**: 2026-03-01
**Status**: Research complete
**Conclusion**: "Damask" is NOT a WebSocket protocol — it's Squarespace's internal UI design system/editor framework. Design settings save mechanisms remain unconfirmed but are most likely REST-based, not WebSocket-based.

---

## Executive Summary

The `api-surface-discovery.md` document hypothesized that "Damask WebSocket protocol" was responsible for writing site-wide settings (fonts, colors, navigation reordering, redirects) that have no known REST endpoints. After thorough investigation, this hypothesis appears to be **incorrect**:

1. **"Damask" is a UI framework name**, not a network protocol. It refers to Squarespace's 7.1 editor panel system.
2. **Zero WebSocket connections** were found across 8 capture runs (text + CSS editing).
3. **`/api/damask` and `/api/damask/config`** both return 404 — no Damask-specific API exists.
4. Design settings (fonts, colors) likely save via **undiscovered REST endpoints** that the capture script hasn't triggered yet, because it never opened the Design panel.

## What "Damask" Actually Is

### Evidence

| Source | Reference | Meaning |
|--------|-----------|---------|
| `_base-damask.less` (public URL) | LESS stylesheet with mixins/variables | Squarespace's internal design system — "plug-and-play vars and mix-ins for styling the system" |
| DOM class names | `sqs-damask-panel`, `sqs-damask-panel-content` | The editor's panel/config UI components |
| `api-settings-discovery.json` | `tutorialsCompleted: { "damask-guide": true, "seven-one-site-styles": true }` | User onboarding tutorial name — "damask" = the 7.1 editor |
| `_base-damask.less` imports | `_variables-base-damask` | Versioned design specification (evolved from earlier "Cameron" system) |

### Conclusion

"Damask" is the codename for Squarespace's 7.1 editor UI framework. It's a LESS-based design system providing:
- Panel components (`sqs-damask-panel`)
- Button styles, form elements, typography mixins
- The visual chrome around the editor — sidebar panels, design settings, page config

It is **not** a network protocol, WebSocket implementation, or data synchronization mechanism.

## Current State of the Capture Script

### What `scripts/capture-websocket.ts` Does

A comprehensive network traffic capture tool that monitors HTTP + WebSocket during Squarespace editor operations.

**Capabilities:**
- Launches Playwright browser with saved session cookies
- Blocks service workers (which previously hid requests from `page.on('request')`)
- Sets up 4 layers of network interception:
  1. `page.on('websocket')` — WebSocket connection monitoring
  2. `page.on('request'/'response')` — standard HTTP monitoring
  3. `context.route('**/*')` — route-level interception (catches iframe-origin requests)
  4. CDP `Fetch.enable` — Chrome DevTools Protocol lowest-level interception
- Additionally hooks `XMLHttpRequest.send`, `navigator.sendBeacon`, and `window.fetch` via in-page JS injection
- Outputs full capture to `data/ws-capture-{timestamp}.json`

**Supported operations:**
- `--action text` — Opens a text block, types content, triggers save via 4 methods (Cmd+S, blur, Escape, navigate away)
- `--action css` — Navigates to `/config/design/custom-css`, types in CodeMirror, saves
- `--action both` — Both operations

**Authentication:** Uses saved Playwright session state (`storage/auth/sqsp-session.json`). Same cookies used by `ContentSaveClient`: `SS_SESSION_ID` + `crumb` token.

### Capture Results (8 Runs, Feb 21-22 2026)

| File | Action | WS Connections | HTTP Mutations |
|------|--------|---------------|----------------|
| `ws-capture-2026-02-21T23-26-32.json` | text | **0** | — |
| `ws-capture-2026-02-21T23-32-11.json` | text | **0** | — |
| `ws-capture-2026-02-21T23-36-56.json` | text | **0** | — |
| `ws-capture-2026-02-21T23-40-54.json` | text | **0** | — |
| `ws-capture-2026-02-21T23-48-04.json` | text | **0** | 118 |
| `ws-capture-2026-02-22T00-00-31.json` | text | **0** | — |
| `ws-capture-2026-02-22T00-11-52.json` | css | **0** | — |
| `ws-capture-2026-02-22T00-23-26.json` | css | **0** | 181 |

**Key finding**: Across all 8 capture runs, **zero WebSocket connections** were established during text editing or CSS editing. All saves use standard REST HTTP endpoints.

### What the Capture Script Does NOT Test

The script has never been used to capture traffic during:
- **Font changes** (Design > Site Styles > Fonts)
- **Color changes** (Design > Site Styles > Colors)
- **Navigation reordering** (Pages panel drag-and-drop)
- **URL redirect management** (Settings > Advanced > URL Redirects)
- **Social link management** (Settings > Social Links)
- **Announcement bar configuration**
- **Business hours editing**

These are the exact operations that `api-surface-discovery.md` attributed to the "Damask protocol."

## WebSocket Endpoint URL Pattern

**No WebSocket URL has been observed.** Specific evidence:

- `wss://` and `ws://` — grep across entire codebase returns zero matches in source files
- `page.on('websocket')` listener is active during all captures — no connections triggered
- `/api/damask` and `/api/damask/config` probed in Round 4 API discovery — both return 404

If WebSockets are used at all, they would only be opened during operations the capture script hasn't tested yet (design panel changes).

## Authentication Mechanism

All known Squarespace editor API requests use the same auth pattern:

1. **Session cookies**: Loaded from Playwright session state (`storage/auth/sqsp-session.json`)
   - `SS_SESSION_ID` — primary session identifier
   - `SS_ANALYTICS_ID` — analytics tracking
   - Site-specific cookies on `{subdomain}.squarespace.com` domain
   - Account cookies on `account.squarespace.com` domain

2. **CSRF crumb token**: Extracted from the `crumb` cookie on the site subdomain
   - Passed as `?crumb=VALUE` query parameter on mutating REST requests
   - Some newer endpoints use `X-CSRF-Token` header instead (e.g., blog post creation)

3. **No special WebSocket auth headers** have been observed (because no WebSocket connections exist in captures)

If design panel operations use WebSocket, they would likely authenticate via:
- Cookie-based auth (cookies are sent on WebSocket upgrade request)
- Possibly an initial handshake message containing the crumb token

## Frame Format Assessment

### Known REST Frame Format (confirmed)
All captured API traffic uses **JSON over HTTP**:
- Content-Type: `application/json`
- Full page sections as JSON array (read-modify-write pattern)
- Crumb token in URL query string or X-CSRF-Token header

### Hypothetical WebSocket Frame Format (speculative)
If WebSockets are used for design settings, likely candidates based on Squarespace's tech stack:
- **JSON messages** (most likely) — Squarespace's API surface is entirely JSON-based
- **NOT binary/protobuf** — No evidence of binary serialization anywhere in the editor
- **NOT collaborative editing protocol** — The editor is single-user; Squarespace engineering explicitly chose REST over WebSocket for cost reasons

### Telemetry Frame Format (observed)
The editor sends extensive telemetry via REST:
- `clanker-events.squarespace.com/api/v1/clanker/events` — analytics events (form-encoded)
- `tracing.squarespace.com/traces/otlp/v0.9` — OpenTelemetry traces (JSON, ~100KB)
- `performance.squarespace.com/api/v1/records` — RUM performance metrics (JSON)
- `prodregistryv2.org/v1/rgstr` — Statsig feature flag telemetry (gzipped binary)

## Recommended Capture Sessions

### Critical Prerequisite

The capture script must be extended with new `--action` modes to test design panel operations. Currently it only supports `text` and `css`.

### Session 1: Font Change

**Steps to reproduce:**
1. Navigate to site editor → Design → Site Styles → Fonts
2. Change a heading font (e.g., Heading 1 font family)
3. Click "Save" or navigate away

**How to capture (script extension needed):**
```
npx tsx scripts/capture-websocket.ts --site grey-yellow-hbxc --action font
```

**Script must:**
1. Navigate to `https://{site}.squarespace.com/config/design/site-styles`
2. Click "Fonts" section
3. Open a font picker, select a different font
4. Trigger save (Cmd+S or navigate away)

**Expected frames:**
- If REST: `POST /api/design/save` or `PUT /api/template/settings` with LESS variable values (e.g., `"heading1FontFamily": "Montserrat"`)
- If WebSocket: Message with operation type + variable name + value

### Session 2: Color Change

**Steps to reproduce:**
1. Navigate to Design → Site Styles → Colors
2. Change a theme color (e.g., accent color)
3. Save

**Script extension:**
```
npx tsx scripts/capture-websocket.ts --site grey-yellow-hbxc --action color
```

**Script must:**
1. Navigate to `https://{site}.squarespace.com/config/design/site-styles`
2. Click "Colors" section
3. Click a color swatch, pick a new color
4. Save

**Expected frames:**
- Likely the same endpoint as font changes (LESS variables are the underlying system for both)
- Color values stored as hex/rgba in LESS variable format

### Session 3: Navigation Reorder

**Steps to reproduce:**
1. Navigate to Pages panel
2. Drag a page to reorder it in the navigation
3. Observe what request fires

**Script extension:**
```
npx tsx scripts/capture-websocket.ts --site grey-yellow-hbxc --action nav-reorder
```

**Script must:**
1. Navigate to `https://{site}.squarespace.com/config/pages`
2. Locate two page entries in the sidebar
3. Perform drag-and-drop to reorder
4. Monitor for save request

**Expected frames:**
- `GET /api/navigation` already works (read-only, confirmed)
- Write likely uses a different endpoint or mechanism
- Possibly `PUT /api/navigation` with modified ordering (but PUT returned 405 in our probes — may need specific payload format)

### Session 4: URL Redirect Add

**Steps to reproduce:**
1. Navigate to Settings → Advanced → URL Mappings
2. Add a redirect rule (e.g., `/old-page -> /new-page`)
3. Save

**Script extension:**
```
npx tsx scripts/capture-websocket.ts --site grey-yellow-hbxc --action redirect
```

**Script must:**
1. Navigate to the URL redirects settings page
2. Add a redirect entry
3. Save
4. Monitor for the save endpoint

**Expected frames:**
- REST POST/PUT to an unknown endpoint
- URL mappings are stored as text format in Squarespace (one mapping per line)

## Risk Assessment: Is the Protocol Decodable?

### Risk Level: LOW (for REST) / MEDIUM (if WebSocket exists)

**Factors favoring decodability:**
1. All observed Squarespace APIs use plain JSON — no encryption, no binary encoding
2. Session cookies provide full auth — no additional API keys or OAuth tokens needed
3. The capture script infrastructure already handles 4 layers of interception
4. Even telemetry uses plain JSON (OpenTelemetry format)
5. Squarespace engineering explicitly prefers REST over WebSocket (2022 engineering blog)

**Factors that could complicate it:**
1. Design settings might use React state management that sends changes via `postMessage` between frames (editor shell ↔ site iframe) — harder to intercept than network traffic
2. Some endpoints might require specific `Content-Type` headers or request body formats that aren't obvious from GET probes alone
3. The `/api/navigation` PUT returning 405 could mean the endpoint exists but needs a specific undocumented format

**Most likely scenario:**
Design settings (fonts, colors) save via an undiscovered REST endpoint — probably:
- `POST /api/template/SaveDesignSettings?crumb=...` (following the `SaveTemplateCustomCss` pattern)
- Or `POST /api/config/Save{Category}?crumb=...` (following the `SaveInjectionSettings` pattern)

The `/api/template/` prefix is promising — `SaveTemplateCustomCss` is confirmed working, suggesting other template-level save endpoints exist.

## Next Steps for Phase 4c-4d Implementation

### Phase 4c: Extend Capture Script (HIGH PRIORITY)

1. **Add `--action font` mode** to `capture-websocket.ts`:
   - Navigate to `/config/design/site-styles`
   - Locate and interact with font picker
   - Monitor for save requests
   - This alone will likely reveal the design settings save endpoint

2. **Add `--action color` mode** — same panel, different controls

3. **Add `--action nav-reorder` mode** — Pages panel drag-and-drop

4. **Add `--action redirect` mode** — Settings > Advanced > URL Mappings

### Phase 4d: Analyze Captured Traffic

1. Run each new capture mode and examine the output JSON
2. Identify the save endpoint URLs and request body formats
3. Document the request/response structure
4. Draft TypeScript types for each operation

### Phase 5: Implement API Methods (if REST endpoints found)

If design settings use REST (most likely):
1. Add `saveDesignSettings()` to `ContentSaveClient`
2. Add `updateNavigation()` if write endpoint is found
3. Add `addUrlRedirect()` if endpoint is found
4. Add corresponding CLI commands to `sq.ts`

### Phase 5-alt: Browser Agent Optimization (if no REST endpoints found)

If design settings truly have no REST API:
1. The browser agent remains the only option for these operations
2. Focus on optimizing the browser agent's Design panel navigation
3. Create specialized compound actions for font/color changes
4. Consider caching design settings reads via `getSettings()` (already read-only confirmed)

## Key Correction to Previous Documentation

The `api-surface-discovery.md` document should be updated:

**Before:** "likely managed through WebSocket/Damask internal protocol"
**After:** "likely managed through undiscovered REST endpoints in the `/api/template/` or `/api/config/` namespace; 'Damask' is Squarespace's UI framework name, not a network protocol"

The term "Damask protocol" should not be used in future documentation. Use "design settings save mechanism" instead.
