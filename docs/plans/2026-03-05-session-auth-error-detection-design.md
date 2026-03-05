# Session Auth Error Detection & Recovery — Design

**Date:** 2026-03-05
**Status:** Approved
**Problem:** Claude Desktop burned through 6+ failed MCP calls before discovering a 42h stale session. The session capture flow then failed because HTTP-only cookies aren't accessible from Playwright MCP's browser context, and the health check said "healthy" after saving useless cookies.

## Root Cause Analysis (from logs)

1. GETs worked with 42h stale session (Squarespace caches reads). PUTs returned `500 {"error":"Something went wrong.","cleaned":true}` — no auth hint.
2. `sq_save_session` accepted 5 non-HTTP-only cookies (1.2KB) replacing a working 2.7MB session with localStorage data. Reported "saved successfully" with `hasCrumb: true` (global crumb, not site-specific).
3. `sq_login` said "healthy (0.1h old)" because it only checks file age + crumb existence. The actual API returned 401.
4. `page.context().storageState()` is a Playwright Node.js API, not accessible from `browser_run_code` which runs in page context.

## Changes

### Bug 1: Write failures with stale sessions (content-save.ts)

- Add `isLikelyAuthError(status, body)` — matches 500+"Something went wrong", 401+loginRequired, 403
- In write methods (`savePageSections`, etc.), when auth error detected + session >24h, enhance error: "Save failed (500). Session is Xh old (max 24h) — likely expired. Call sq_login to refresh."
- Soft warning before writes when session >24h (log, don't block)

### Bug 2: sq_save_session validation (auth.ts)

- Check for site-specific cookies (domain matches configured subdomain). Warn if siteCookies === 0.
- Check for known critical HTTP-only cookies (SS_MID, JSESSIONID). Warn if missing.
- Compare against backup cookie count. Warn if new << old.
- Return `status: "saved_with_warnings"` with guidance, still save.

### Bug 3: sq_login active probe (auth.ts)

- After file check says "healthy", make actual API call: `GET /api/commondata/GetCollections/`
- If returns 401, report `status: "session_invalid"` with actual API error
- Falls back gracefully if no sites configured

### Bug 4: Session restore + updated instructions (auth.ts)

- New `sq_restore_session` tool — restores from `.bak` file
- Updated `sq_login` instructions — remove broken storageState approach, explain HTTP-only limitation, point to manual export or restore

### Files

| File | Changes |
|------|---------|
| `src/services/content-save.ts` | `isLikelyAuthError()`, enhanced write error messages |
| `src/mcp-server/tools/auth.ts` | Active probe, validation, `sq_restore_session`, updated instructions |
