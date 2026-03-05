/**
 * MCP Tools — Squarespace session authentication
 *
 * sq_login: Check session health (file + active API probe) and return login instructions
 * sq_save_session: Accept session cookies JSON, validate quality, and save as session
 * sq_restore_session: Recover previous session from .bak backup after bad cookie save
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { reloadAllSessions } from '../session.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const SESSION_DIR = process.env.SESSION_DIR ?? join(PROJECT_ROOT, 'storage', 'auth');
const SESSION_PATH = join(SESSION_DIR, 'sqsp-session.json');

export function registerAuthTools(server: McpServer) {
  // ── sq_login ──────────────────────────────────────────────────────────────
  server.registerTool('sq_login', {
    description:
      'Check Squarespace session health. If the session is valid, returns status "healthy". ' +
      'If missing or stale (>24h), returns status "login_required" with step-by-step instructions ' +
      'for using Playwright MCP to log in and capture session cookies. ' +
      'After login, pass the storageState JSON to sq_save_session.',
    inputSchema: {
      siteId: z.string().optional().describe('Optional site ID for site-specific health check'),
    },
  }, async ({ siteId }) => {
    try {
      const { ContentSaveClient } = await import('../../services/content-save.js');
      const health = ContentSaveClient.checkSessionHealth(SESSION_PATH);

      if (health.exists && !health.isStale && health.hasCrumb) {
        // Active probe: try an actual API call to verify cookies work
        try {
          const { getClient, listSites } = await import('../session.js');
          const sites = listSites();
          if (sites.length > 0) {
            const client = getClient(sites[0].id);
            const collections = await client.listCollections();
            // If we get here without throwing, session is genuinely valid
            // (listCollections throws on 401)
          }
        } catch (probeErr) {
          const probeMsg = probeErr instanceof Error ? probeErr.message : String(probeErr);
          if (probeMsg.includes('401') || probeMsg.includes('Unauthorized') || probeMsg.includes('not logged in')) {
            // File looks healthy but API says no — session cookies are invalid
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({
                status: 'session_invalid',
                reason: `Session file exists and looks healthy (${Math.round(health.ageHours * 10) / 10}h old) but API returned 401 Unauthorized. The saved cookies are likely incomplete or corrupted.`,
                suggestion: 'If you recently used sq_save_session, the captured cookies may be missing HTTP-only auth cookies. Try sq_restore_session to recover the previous working session, or re-export cookies from your browser.',
                loginUrl: 'https://login.squarespace.com',
              }, null, 2) }],
            };
          }
          // Non-auth error (network, timeout, etc) — still report file-level health
        }

        // If probe succeeded or had non-auth error, report healthy
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            status: 'healthy',
            ageHours: Math.round(health.ageHours * 10) / 10,
            sessionPath: SESSION_PATH,
            message: `Session is valid (${Math.round(health.ageHours * 10) / 10}h old). No login needed.`,
          }, null, 2) }],
        };
      }

      // Session missing, stale, or lacks crumb — need login
      const reason = !health.exists
        ? 'No session file found'
        : !health.hasCrumb
          ? 'Session file exists but is missing crumb token (corrupt or incomplete)'
          : `Session is stale (${Math.round(health.ageHours)}h old, max 24h)`;

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          status: 'login_required',
          reason,
          loginUrl: 'https://login.squarespace.com',
          instructions: [
            '1. The Playwright MCP browser_run_code runs in browser page context, NOT Node.js — it CANNOT call page.context().storageState(). HTTP-only cookies (required for Squarespace auth) are invisible to document.cookie.',
            '2. RECOMMENDED: Ask the user to manually export cookies from their browser:',
            '   - Chrome: DevTools → Application → Cookies → right-click → Copy all',
            '   - Or use a browser extension like "EditThisCookie" or "Cookie-Editor" to export as JSON',
            '3. Format the cookies as Playwright storageState JSON: { "cookies": [...], "origins": [] }',
            '4. Pass the JSON to sq_save_session({ sessionData: <the JSON string> })',
            '5. If sq_save_session was recently called with bad cookies, use sq_restore_session to recover the previous working session.',
          ],
        }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_save_session ───────────────────────────────────────────────────────
  server.registerTool('sq_save_session', {
    description:
      'Save Playwright browser session as Squarespace session cookies. ' +
      'Accepts the JSON string output from page.context().storageState() in Playwright. ' +
      'Validates the session contains cookies and a crumb token, backs up existing session, ' +
      'and reloads all cached MCP clients.',
    inputSchema: {
      sessionData: z.string().describe('JSON string from Playwright page.context().storageState()'),
    },
  }, async ({ sessionData }) => {
    try {
      // Parse and validate
      let parsed: any;
      try {
        parsed = JSON.parse(sessionData);
      } catch {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            status: 'error',
            message: 'Invalid JSON. The sessionData must be the raw JSON string from page.context().storageState().',
          }, null, 2) }],
          isError: true,
        };
      }

      // Must have cookies array
      if (!Array.isArray(parsed.cookies)) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            status: 'error',
            message: 'Invalid session data: missing "cookies" array. This should be the output of page.context().storageState().',
          }, null, 2) }],
          isError: true,
        };
      }

      if (parsed.cookies.length === 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            status: 'error',
            message: 'Session has 0 cookies. Make sure you are logged in before capturing the session.',
          }, null, 2) }],
          isError: true,
        };
      }

      // Check for crumb token
      const hasCrumb = parsed.cookies.some((c: { name: string }) => c.name === 'crumb');

      // Extract site subdomains from cookies
      const sqspDomains = new Set<string>();
      for (const cookie of parsed.cookies) {
        const domain: string = cookie.domain ?? '';
        const match = domain.match(/\.?([a-z0-9-]+)\.squarespace\.com$/);
        if (match) sqspDomains.add(match[1]);
      }

      // ── Validate session quality ──────────────────────────────────────────
      const warnings: string[] = [];

      // Check for site-specific cookies
      const { listSites } = await import('../session.js');
      let configuredSubdomains: string[] = [];
      try {
        configuredSubdomains = listSites().map(s => s.subdomain);
      } catch { /* no sites config */ }

      if (configuredSubdomains.length > 0) {
        const hasSiteCookies = parsed.cookies.some((c: { domain: string }) => {
          const cdomain = c.domain.replace(/^\./, '');
          return configuredSubdomains.some(sub => cdomain.includes(sub));
        });
        if (!hasSiteCookies) {
          warnings.push(`No site-specific cookies found for configured sites (${configuredSubdomains.join(', ')}). This session likely only has global cookies from document.cookie and is missing HTTP-only auth cookies.`);
        }
      }

      // Check for known critical HTTP-only cookies
      const criticalCookies = ['SS_MID', 'JSESSIONID'];
      const missingCritical = criticalCookies.filter(name =>
        !parsed.cookies.some((c: { name: string }) => c.name === name)
      );
      if (missingCritical.length > 0) {
        warnings.push(`Missing critical cookies: ${missingCritical.join(', ')}. These are HTTP-only cookies that cannot be captured via document.cookie in the browser.`);
      }

      // Compare against existing session
      if (existsSync(SESSION_PATH)) {
        try {
          const backup = JSON.parse(readFileSync(SESSION_PATH, 'utf-8'));
          const backupCount = backup.cookies?.length ?? 0;
          if (backupCount > 10 && parsed.cookies.length < backupCount * 0.5) {
            warnings.push(`New session has ${parsed.cookies.length} cookies but the existing session has ${backupCount}. This looks like an incomplete capture. The existing session will be backed up to .bak.`);
          }
        } catch { /* ignore parse errors */ }
      }

      // Ensure storage directory exists
      mkdirSync(SESSION_DIR, { recursive: true });

      // Backup existing session
      if (existsSync(SESSION_PATH)) {
        copyFileSync(SESSION_PATH, SESSION_PATH + '.bak');
      }

      // Write new session
      writeFileSync(SESSION_PATH, JSON.stringify(parsed, null, 2), 'utf-8');

      // Reload all cached clients so they pick up the new session
      reloadAllSessions();

      const status = warnings.length > 0 ? 'saved_with_warnings' : 'saved';
      const baseMessage = hasCrumb
        ? `Session saved with ${parsed.cookies.length} cookies. Squarespace API is ready to use.`
        : `Session saved with ${parsed.cookies.length} cookies but NO crumb token found. API calls may fail — try logging in again.`;

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          status,
          cookieCount: parsed.cookies.length,
          hasCrumb,
          sites: Array.from(sqspDomains),
          sessionPath: SESSION_PATH,
          ...(warnings.length > 0 ? { warnings } : {}),
          message: warnings.length > 0
            ? `${baseMessage} WARNING: ${warnings.join(' ')}`
            : baseMessage,
        }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_restore_session ────────────────────────────────────────────────────
  server.registerTool('sq_restore_session', {
    description:
      'Restore the previous Squarespace session from backup. ' +
      'When sq_save_session overwrites a working session with bad cookies, ' +
      'this tool recovers the .bak backup file. Use this when sq_login reports ' +
      'session_invalid after a recent sq_save_session.',
    inputSchema: {},
  }, async () => {
    try {
      const backupPath = SESSION_PATH + '.bak';
      if (!existsSync(backupPath)) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            status: 'error',
            message: 'No backup session file found. sq_save_session creates a .bak before overwriting.',
          }, null, 2) }],
          isError: true,
        };
      }

      // Validate backup
      const backup = JSON.parse(readFileSync(backupPath, 'utf-8'));
      const cookieCount = backup.cookies?.length ?? 0;
      const hasCrumb = backup.cookies?.some((c: { name: string }) => c.name === 'crumb') ?? false;
      const stats = statSync(backupPath);
      const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);

      // Restore: copy backup over current
      copyFileSync(backupPath, SESSION_PATH);

      // Reload clients
      reloadAllSessions();

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          status: 'restored',
          cookieCount,
          hasCrumb,
          ageHours: Math.round(ageHours * 10) / 10,
          sessionPath: SESSION_PATH,
          message: `Previous session restored (${cookieCount} cookies, ${Math.round(ageHours * 10) / 10}h old). ${hasCrumb ? 'Has crumb token.' : 'WARNING: No crumb token.'} Run sq_login to verify.`,
        }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });
}
