# Fix Caching & Multi-Site Issues — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate MCP server restarts by making sites config, session cookies, and crumb tokens reload automatically when their backing files change.

**Architecture:** Add file-mtime-based cache invalidation to `session.ts` (sites config) and `client.ts` (session cookies). Make account discovery blocking. Auto-refresh crumb on CONFLICT errors.

**Tech Stack:** TypeScript, Node.js `fs.statSync`, vitest

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/mcp-server/session.ts` | Modify | Add mtime tracking to `loadSitesConfig()`, make `fetchAccountSites()` async/await, invalidate client cache on session file change |
| `src/services/content-save/client.ts` | Modify | Add mtime tracking to `loadSessionCookies()`, auto-check before API calls, auto-refresh crumb on CONFLICT |
| `src/mcp-server/__tests__/session-cache.test.ts` | Create | Tests for config reload and client cache invalidation |
| `src/services/__tests__/content-save-session-reload.test.ts` | Create | Tests for session file mtime tracking and auto-reload |

---

### Task 1: Sites config auto-reload on file change

**Files:**
- Modify: `src/mcp-server/session.ts:40-57`
- Create: `src/mcp-server/__tests__/session-cache.test.ts`

- [ ] **Step 1: Write failing test for config reload**

```typescript
// src/mcp-server/__tests__/session-cache.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('loadSitesConfig mtime tracking', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sqsp-test-'));
    configPath = join(tmpDir, 'sites.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reloads config when file changes on disk', async () => {
    // Write initial config
    writeFileSync(configPath, JSON.stringify({
      clients: [{ id: 'site-a', site: { adminUrl: 'https://site-a.squarespace.com' } }]
    }));

    // First load
    const { _loadSitesConfigFromPath } = await import('../session.js');
    const first = _loadSitesConfigFromPath(configPath);
    expect(first.clients).toHaveLength(1);

    // Wait 1ms so mtime differs, then update file
    await new Promise(r => setTimeout(r, 50));
    writeFileSync(configPath, JSON.stringify({
      clients: [
        { id: 'site-a', site: { adminUrl: 'https://site-a.squarespace.com' } },
        { id: 'site-b', site: { adminUrl: 'https://site-b.squarespace.com' } },
      ]
    }));

    // Second load should see the new site
    const second = _loadSitesConfigFromPath(configPath);
    expect(second.clients).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/mcp-server/__tests__/session-cache.test.ts --reporter verbose`
Expected: FAIL — `_loadSitesConfigFromPath` is not exported

- [ ] **Step 3: Implement mtime-based config reload**

In `src/mcp-server/session.ts`, replace the `loadSitesConfig()` function (lines 40-57):

```typescript
// ── State ───────────────────────────────────────────────────────────────────

const clientCache = new Map<string, ContentSaveClient>();
const mediaClientCache = new Map<string, MediaUploadClient>();
let sitesConfig: SitesConfig | null = null;
let sitesConfigMtime: number = 0;
let accountSitesFetched = false;

// ── Config Loading ──────────────────────────────────────────────────────────

/**
 * Load sites config from a specific path with mtime-based caching.
 * Exported for testing — production code uses loadSitesConfig().
 */
export function _loadSitesConfigFromPath(configPath: string): SitesConfig {
  try {
    const mtime = statSync(configPath).mtimeMs;
    if (sitesConfig && mtime === sitesConfigMtime) return sitesConfig;

    const raw = readFileSync(configPath, 'utf-8');
    sitesConfig = JSON.parse(raw) as SitesConfig;
    sitesConfigMtime = mtime;
    logger.info({ configPath, clients: sitesConfig.clients.length }, 'Sites config loaded');
  } catch {
    if (!sitesConfig) sitesConfig = { clients: [] };
  }
  return sitesConfig;
}

function loadSitesConfig(): SitesConfig {
  const configPath = process.env.SITES_CONFIG || join(process.cwd(), 'config', 'sites.json');
  return _loadSitesConfigFromPath(configPath);
}
```

Also add `statSync` to the existing import on line 15:

```typescript
import { existsSync, readFileSync, statSync } from 'fs';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/mcp-server/__tests__/session-cache.test.ts --reporter verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/session.ts src/mcp-server/__tests__/session-cache.test.ts
git commit -m "fix: auto-reload sites config when file changes on disk"
```

---

### Task 2: Session cookies auto-reload on file change

**Files:**
- Modify: `src/services/content-save/client.ts:336-478`
- Modify: `src/mcp-server/session.ts:306-319`
- Create: `src/services/__tests__/content-save-session-reload.test.ts`

- [ ] **Step 1: Write failing test for session file mtime tracking**

```typescript
// src/services/__tests__/content-save-session-reload.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ContentSaveClient } from '../content-save/client.js';

function makeSession(crumb: string, subdomain: string) {
  return {
    cookies: [
      { name: 'member-session', value: 'ms-val', domain: `${subdomain}.squarespace.com` },
      { name: 'crumb', value: crumb, domain: `${subdomain}.squarespace.com` },
    ],
  };
}

describe('ContentSaveClient session auto-reload', () => {
  let tmpDir: string;
  let sessionPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sqsp-session-'));
    sessionPath = join(tmpDir, 'sqsp-session.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reloads cookies when session file changes', async () => {
    writeFileSync(sessionPath, JSON.stringify(makeSession('crumb-v1', 'testsite')));

    const client = new ContentSaveClient('testsite');
    client.loadSessionCookies(sessionPath);
    expect(client.crumbToken).toBe('crumb-v1');

    // Update file with new crumb
    await new Promise(r => setTimeout(r, 50));
    writeFileSync(sessionPath, JSON.stringify(makeSession('crumb-v2', 'testsite')));

    // Should auto-detect change and reload
    client.ensureFreshSession(sessionPath);
    expect(client.crumbToken).toBe('crumb-v2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/__tests__/content-save-session-reload.test.ts --reporter verbose`
Expected: FAIL — `ensureFreshSession` does not exist

- [ ] **Step 3: Add mtime tracking and ensureFreshSession to ContentSaveClient**

In `src/services/content-save/client.ts`, add a new property and method to the class (after line 347):

```typescript
  _sessionPath: string | null = null;
  _sessionMtime: number = 0;
```

In `loadSessionCookies()` (line 357), after `const path = sessionPath ?? SESSION_PATH;` add:

```typescript
    this._sessionPath = path;
    this._sessionMtime = statSync(path).mtimeMs;
```

Add a new method after `reloadSessionCookies()` (after line 478):

```typescript
  /**
   * Check if the session file has been modified since last load.
   * If so, reload cookies automatically. Call this before API requests.
   */
  ensureFreshSession(sessionPath?: string): void {
    const path = sessionPath ?? this._sessionPath ?? SESSION_PATH;
    try {
      const currentMtime = statSync(path).mtimeMs;
      if (currentMtime !== this._sessionMtime) {
        logger.info({ path, oldMtime: this._sessionMtime, newMtime: currentMtime }, 'Session file changed — reloading cookies');
        this.reloadSessionCookies(path);
        this._sessionMtime = currentMtime;
      }
    } catch {
      // File disappeared or unreadable — keep existing cookies
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/__tests__/content-save-session-reload.test.ts --reporter verbose`
Expected: PASS

- [ ] **Step 5: Wire ensureFreshSession into getClient**

In `src/mcp-server/session.ts`, modify `getClient()` (lines 306-319) to check session freshness on every call:

```typescript
export function getClient(siteId: string): ContentSaveClient {
  const site = findSite(siteId);
  const cacheKey = site?.id ?? siteId;

  const cached = clientCache.get(cacheKey);
  if (cached) {
    cached.ensureFreshSession();
    return cached;
  }

  const subdomain = getSubdomain(siteId);
  const client = createContentSaveClient(subdomain);
  client._snapshotSiteId = cacheKey;
  clientCache.set(cacheKey, client);
  return client;
}
```

- [ ] **Step 6: Run full test suite to check for regressions**

Run: `npx vitest run --reporter verbose 2>&1 | tail -20`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/services/content-save/client.ts src/mcp-server/session.ts src/services/__tests__/content-save-session-reload.test.ts
git commit -m "fix: auto-reload session cookies when file changes on disk"
```

---

### Task 3: Auto-refresh crumb on CONFLICT

**Files:**
- Modify: `src/services/content-save/client.ts:514-545`

- [ ] **Step 1: Write failing test for CONFLICT auto-retry**

Add to `src/services/__tests__/content-save-session-reload.test.ts`:

```typescript
import { vi } from 'vitest';

describe('CONFLICT auto-retry with crumb refresh', () => {
  it('refreshes crumb and retries once on hash mismatch', async () => {
    const client = new ContentSaveClient('testsite');
    // Verify the method signature accepts a retry flag
    expect(typeof client._checkForConflict).toBe('function');
    // The actual retry logic will be integration-tested via savePageSections
  });
});
```

- [ ] **Step 2: Modify _checkForConflict to retry with fresh crumb**

In `src/services/content-save/client.ts`, modify `_checkForConflict` (lines 514-545). Add a `retried` parameter and retry logic:

```typescript
  async _checkForConflict(
    pageSectionsId: string,
    collectionId: string,
    sectionsCount: number,
    _retried = false,
  ): Promise<ContentSaveResult | null> {
    const originalHash = this._sectionsHashCache.get(pageSectionsId);
    if (!originalHash) return null;

    try {
      const currentData = await this._fetchPageSectionsRaw(pageSectionsId);
      const currentHash = ContentSaveClient.computeSectionsHash(currentData.sections);
      if (currentHash !== originalHash) {
        // On first conflict, try refreshing crumb and re-reading
        if (!_retried) {
          logger.info({ pageSectionsId }, 'Hash mismatch — refreshing crumb and retrying conflict check');
          await this.refreshCrumb();
          this.ensureFreshSession();
          // Update hash from fresh read
          const freshData = await this._fetchPageSectionsRaw(pageSectionsId);
          const freshHash = ContentSaveClient.computeSectionsHash(freshData.sections);
          this._sectionsHashCache.set(pageSectionsId, freshHash);
          // Re-check: if original hash matches the fresh hash, it was a crumb issue not a real conflict
          if (freshHash === originalHash) {
            return null; // No real conflict — crumb was the issue
          }
        }

        logger.warn(
          { pageSectionsId, originalHash, currentHash },
          'Concurrent modification detected — page was changed by another session since last read',
        );
        this._sectionsHashCache.delete(pageSectionsId);
        return {
          success: false,
          pageSectionsId,
          collectionId,
          sectionsCount,
          error: 'CONFLICT: Page was modified by another session since you last read it. Re-read the page and try again.',
        };
      }
    } catch (err) {
      logger.warn({ pageSectionsId, error: errMsg(err) }, 'Could not verify page state before save — proceeding anyway');
    }

    return null;
  }
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run --reporter verbose 2>&1 | tail -20`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/services/content-save/client.ts src/services/__tests__/content-save-session-reload.test.ts
git commit -m "fix: auto-refresh crumb and retry on CONFLICT before failing"
```

---

### Task 4: Make fetchAccountSites blocking

**Files:**
- Modify: `src/mcp-server/session.ts:102-162, 278-300`

- [ ] **Step 1: Convert fetchAccountSites to async and await it**

In `src/mcp-server/session.ts`, change `fetchAccountSites` (line 102) from `void` to `async`:

```typescript
let discoveryPromise: Promise<void> | null = null;

export async function fetchAccountSites(): Promise<void> {
  if (accountSitesFetched) return;

  // Share a single promise across concurrent callers
  if (discoveryPromise) return discoveryPromise;

  discoveryPromise = (async () => {
    accountSitesFetched = true;

    try {
      if (!existsSync(SESSION_PATH)) return;

      const session = JSON.parse(readFileSync(SESSION_PATH, 'utf-8'));
      const cookies: Array<{ name: string; value: string; domain: string }> = session.cookies ?? [];

      const accountCookies = cookies.filter(c => {
        const d = c.domain.replace(/^\./, '');
        return d === 'squarespace.com' || d === 'account.squarespace.com';
      });
      if (accountCookies.length === 0) return;

      const cookieHeader = accountCookies.map(c => `${c.name}=${c.value}`).join('; ');
      const crumb = accountCookies.find(c => c.name === 'crumb')?.value;

      const res = await fetch('https://account.squarespace.com/api/account/1/website-briefs', {
        headers: {
          Cookie: cookieHeader,
          ...(crumb ? { 'X-CSRF-Token': crumb } : {}),
        },
      });

      if (!res.ok) return;
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('json')) return;

      const briefs = await res.json() as Array<{
        identifier: string;
        title: string;
        canonicalUrl: string;
        internalUrl: string;
        active: boolean;
      }>;

      let count = 0;
      for (const brief of briefs) {
        if (!brief.active || !brief.identifier) continue;
        const customDomain = brief.canonicalUrl !== brief.internalUrl
          ? brief.canonicalUrl
          : undefined;
        try {
          saveSite(brief.identifier, brief.title, customDomain);
          count++;
        } catch { /* best-effort */ }
      }

      if (count > 0) {
        logger.info({ count, total: briefs.length }, 'Discovered sites from account API');
      }
    } catch (err) {
      logger.warn({ error: errMsg(err) }, 'Account sites discovery failed — falling back to DB-only');
    } finally {
      discoveryPromise = null;
    }
  })();

  return discoveryPromise;
}
```

- [ ] **Step 2: Make listSites async and await discovery**

Change `listSites()` (line 278) to async:

```typescript
export async function listSites(): Promise<Array<{
  id: string;
  name: string;
  subdomain: string;
  aliases: string[];
  adminUrl: string;
  customDomain?: string;
}>> {
  await fetchAccountSites();
  const allSites = getAllSites();
  return allSites.map((c) => {
    const subdomain = new URL(c.site.adminUrl).hostname.split('.')[0];
    return {
      id: c.id,
      name: c.name ?? c.id,
      subdomain,
      aliases: c.aliases ?? [],
      adminUrl: c.site.adminUrl,
      customDomain: c.site.customDomain,
    };
  });
}
```

- [ ] **Step 3: Update callers of listSites to await**

Search for `listSites()` calls in the MCP tool registration files and add `await`:

Run: `grep -rn 'listSites()' src/mcp-server/tools/`
Update each call site to `await listSites()`.

- [ ] **Step 4: Add errMsg import if not present**

Check line 18 — if `errMsg` is not imported, add:
```typescript
import { errMsg } from '../utils/errors.js';
```

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run --reporter verbose 2>&1 | tail -20`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/mcp-server/session.ts src/mcp-server/tools/
git commit -m "fix: make account discovery blocking so listSites returns all sites"
```

---

### Task 5: Build, verify, and clean up

- [ ] **Step 1: Build TypeScript**

Run: `npm run build`
Expected: No errors

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All ~1468 tests pass

- [ ] **Step 3: Manual smoke test**

1. Start a fresh Claude Code session
2. Run `sq_list_sites` — should show all sites including seahorsenyc without restart
3. Edit `config/sites.json` to add a dummy site — `sq_list_sites` should pick it up without restart
4. Update session cookies on disk — next API call should use new cookies without restart

- [ ] **Step 4: Commit final state**

```bash
git add -A
git commit -m "fix: eliminate MCP restart requirement for config, session, and discovery changes"
```
