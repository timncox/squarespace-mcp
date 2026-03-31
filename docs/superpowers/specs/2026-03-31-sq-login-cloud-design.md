# sq_login_cloud — Cloud Browser Authentication for Squarespace MCP

**Date:** 2026-03-31
**Status:** Approved

## Problem

The Squarespace MCP server authenticates via session cookies captured by launching a local headful Chromium browser (Playwright). This requires a local display and a ~300MB Chromium binary. Cloud-based MCP clients, headless servers, and remote development environments cannot use this flow.

## Solution

Add `sq_login_cloud` — a new MCP tool that uses [Browserbase](https://www.browserbase.com/) to run Chromium in the cloud. The user receives a live view URL, logs in via their own browser, and the tool captures cookies over CDP. The existing `sq_login_browser` remains unchanged for local users.

## Architecture

### New tool: `sq_login_cloud`

**Location:** `src/mcp-server/tools/auth.ts` (alongside existing auth tools)

**Flow:**

1. Check `BROWSERBASE_API_KEY` env var — fail fast with setup instructions if missing
2. Create a Browserbase session via `@browserbasehq/sdk`
3. Connect Playwright over CDP using `chromium.connectOverCDP(session.connectUrl)`
4. Navigate to `https://login.squarespace.com` (or custom `loginUrl`)
5. Return the Browserbase live view URL immediately in the MCP response
6. Poll for `member-session` cookie every 2 seconds (same as local tool)
7. On detection: call shared `saveSessionAndDiscoverSites()` helper
8. Return success with cookie count, crumb status, and captured sites
9. On timeout: return error with instructions
10. Always close the CDP connection in `finally` block

**Input schema:**

```typescript
{
  loginUrl: z.string().optional(),   // default: https://login.squarespace.com
  timeoutMs: z.number().optional(),  // default: 300000 (5 minutes)
}
```

**Output (success):**

```json
{
  "status": "saved",
  "cookieCount": 42,
  "hasCrumb": true,
  "hasMemberSession": true,
  "capturedSites": ["grey-yellow-hbxc", "tim-cox-abc"],
  "sessionPath": "/path/to/sqsp-session.json",
  "message": "Cloud login successful. Session saved with 42 cookies. Captured site-specific cookies for 2 site(s)."
}
```

**Output (missing API key):**

```json
{
  "status": "error",
  "message": "BROWSERBASE_API_KEY not set. Set this environment variable to use cloud login. Get a key at https://www.browserbase.com/. Alternatively, use sq_login_browser for local login with Chromium."
}
```

### Shared helper: `saveSessionAndDiscoverSites()`

Extract the post-login flow currently duplicated inside `sq_login_browser` (lines 189-237) into a reusable function:

```typescript
async function saveSessionAndDiscoverSites(
  fullState: { cookies: any[]; origins: any[] },
): Promise<{
  cookieCount: number;
  hasCrumb: boolean;
  capturedSites: string[];
}>
```

**Responsibilities:**
1. Backup existing session to `.bak`
2. Write new session to `SESSION_PATH`
3. Call `reloadAllSessions()`
4. Call `fetchAccountSites()` (discovers sites + captures missing crumbs)
5. Re-read session, count cookies, check for crumb
6. Call `reloadAllSessions()` again
7. Return summary

Both `sq_login_browser` and `sq_login_cloud` call this helper after detecting `member-session`.

### Updates to `sq_login` health check

When session is missing or stale, mention both login options:

```
"Use sq_login_browser for local login (launches Chromium on your machine),
 or sq_login_cloud for cloud login (opens a URL in your browser — requires BROWSERBASE_API_KEY)."
```

## Dependencies

### New dependency: `@browserbasehq/sdk`

- Added to `dependencies` in `package.json`
- Imported dynamically (`await import('@browserbasehq/sdk')`) inside `sq_login_cloud` handler only — the module is not loaded at startup, so missing/broken installs don't affect the other 133 tools
- For CDP connection: use `playwright-core`'s `chromium.connectOverCDP()` (we already have full `playwright` which includes `playwright-core`)
- If the dynamic import fails (e.g., SDK not installed), return a clear error suggesting `npm install @browserbasehq/sdk`

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `BROWSERBASE_API_KEY` | For cloud login only | API key from browserbase.com |
| `BROWSERBASE_PROJECT_ID` | Optional | Browserbase project ID (uses default if omitted) |

Added to `.mcp.json` as optional env vars (not set by default — existing setups unchanged).

## Error Handling

| Scenario | Behavior |
|---|---|
| `BROWSERBASE_API_KEY` not set | Return error with setup instructions |
| Browserbase session creation fails | Return error with status details |
| CDP connection fails | Return error, no cleanup needed (no browser to close) |
| CDP connection drops mid-login | Catch in poll loop, return error |
| User doesn't complete login | Timeout after 5 minutes (configurable), return timeout error |
| Session save fails | Return error (same as local tool) |
| `fetchAccountSites` fails | Best-effort — account-level login still succeeds |

## Testing

### Unit tests

- `saveSessionAndDiscoverSites()` — test session save, backup, reload, and site discovery
  - Mock `fetchAccountSites`, `reloadAllSessions`, and filesystem operations
  - Verify backup is created before overwrite
  - Verify crumb detection and site counting

### Integration tests (manual, requires Browserbase credentials)

- `sq_login_cloud` with valid API key — verify session is created and URL returned
- Timeout behavior — verify clean error message
- Missing API key — verify clear error with instructions

### Existing test impact

- `sq_login_browser` tests unaffected — only change is extracting the helper
- Verify the refactored `sq_login_browser` still passes by calling the shared helper

## Files Changed

| File | Change |
|---|---|
| `src/mcp-server/tools/auth.ts` | Add `sq_login_cloud` tool, extract `saveSessionAndDiscoverSites()` helper, refactor `sq_login_browser` to use helper, update `sq_login` message |
| `package.json` | Add `@browserbasehq/sdk` dependency |
| `.mcp.json` | Add optional `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` env vars |

## Out of Scope

- HTTP/SSE transport (separate migration step)
- SQLite → cloud database migration
- Multi-tenancy / per-user session storage
- Changes to any of the 130+ content editing tools
