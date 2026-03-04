/**
 * MCP Tools — Squarespace session authentication via Playwright
 *
 * sq_login: Check session health and return Playwright login instructions
 * sq_save_session: Accept storageState JSON from Playwright and save as session
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
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
            '1. Use Playwright MCP to navigate to https://login.squarespace.com',
            '2. Take a snapshot to see the login form',
            '3. Ask the user to log in to Squarespace (they may need to handle 2FA)',
            '4. Wait for the user to confirm they have logged in',
            '5. Take a snapshot — verify the URL contains "account.squarespace.com" or shows the dashboard',
            '6. Run this JavaScript via Playwright to capture the session:',
            '   browser_run_code({ code: "async (page) => JSON.stringify(await page.context().storageState())" })',
            '7. Pass the resulting JSON string to sq_save_session({ sessionData: <the JSON string> })',
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

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          status: 'saved',
          cookieCount: parsed.cookies.length,
          hasCrumb,
          sites: Array.from(sqspDomains),
          sessionPath: SESSION_PATH,
          message: hasCrumb
            ? `Session saved with ${parsed.cookies.length} cookies. Squarespace API is ready to use.`
            : `Session saved with ${parsed.cookies.length} cookies but NO crumb token found. API calls may fail — try logging in again.`,
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
