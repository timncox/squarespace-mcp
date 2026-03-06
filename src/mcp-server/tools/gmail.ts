/**
 * MCP Tools — Gmail browser login + attachment download
 *
 * sq_login_gmail: Launch Playwright browser for Gmail login, capture cookies
 * sq_download_attachment: Download email attachment using saved cookies
 *
 * Search/read handled by Claude.ai Gmail MCP — we only fill the attachment gap.
 */

import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const SESSION_DIR = join(PROJECT_ROOT, 'storage', 'auth');
const SESSION_PATH = join(SESSION_DIR, 'gmail-session.json');

const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 2_000;

export function registerGmailTools(server: McpServer) {
  // ── sq_login_gmail ─────────────────────────────────────────────────────────
  server.registerTool('sq_login_gmail', {
    description:
      'Launch a browser window for Gmail login. The user logs in manually, ' +
      'and the tool automatically captures session cookies (including HTTP-only) ' +
      'once authentication is detected. No Google Cloud project or OAuth setup needed.',
    inputSchema: {
      timeoutMs: z.number().optional().describe(
        `Max milliseconds to wait for login (default ${DEFAULT_TIMEOUT_MS})`,
      ),
    },
  }, async ({ timeoutMs }) => {
    const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let browser: any = null;

    try {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({ headless: false });
      const context = await browser.newContext();
      const page = await context.newPage();

      await page.goto('https://mail.google.com', { waitUntil: 'domcontentloaded' });

      // Poll for GMAIL_AT cookie — indicates successful Gmail login
      const cookies = await new Promise<any[]>((resolve, reject) => {
        const deadline = Date.now() + timeout;

        const poll = async () => {
          try {
            const allCookies = await context.cookies();
            const hasGmailAt = allCookies.some(
              (c: { name: string }) => c.name === 'GMAIL_AT',
            );

            if (hasGmailAt) {
              resolve(allCookies);
              return;
            }

            if (Date.now() >= deadline) {
              reject(new Error('timeout'));
              return;
            }

            setTimeout(poll, POLL_INTERVAL_MS);
          } catch (err) {
            reject(err);
          }
        };

        poll();
      });

      // Save session
      mkdirSync(SESSION_DIR, { recursive: true });

      if (existsSync(SESSION_PATH)) {
        copyFileSync(SESSION_PATH, SESSION_PATH + '.bak');
      }

      const storageState = { cookies, origins: [] };
      writeFileSync(SESSION_PATH, JSON.stringify(storageState, null, 2), 'utf-8');

      await browser.close();
      browser = null;

      const hasGmailAt = cookies.some((c: { name: string }) => c.name === 'GMAIL_AT');

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          status: 'saved',
          cookieCount: cookies.length,
          hasGmailAt,
          sessionPath: SESSION_PATH,
          message: `Gmail session saved with ${cookies.length} cookies. Attachment downloads are now ready.`,
        }, null, 2) }],
      };
    } catch (err) {
      if (browser) {
        try { await browser.close(); } catch { /* best effort */ }
      }

      const msg = err instanceof Error ? err.message : String(err);

      if (msg === 'timeout') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            status: 'timeout',
            message: `Login timed out after ${timeout}ms. Please try again and complete the Gmail login within the time limit.`,
          }, null, 2) }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: `Error: ${msg}` }],
        isError: true,
      };
    }
  });

  // ── sq_download_attachment ─────────────────────────────────────────────────
  server.registerTool('sq_download_attachment', {
    description:
      'Download an email attachment to disk using saved Gmail session cookies. ' +
      'Returns the local file path. Requires sq_login_gmail to have been run first.',
    inputSchema: {
      messageId: z.string().describe('Gmail message ID (from Claude.ai Gmail MCP)'),
      filename: z.string().describe('Filename of the attachment to download'),
    },
  }, async ({ messageId, filename }) => {
    try {
      const { downloadAttachment } = await import('../../services/gmail.js');
      const filePath = await downloadAttachment(messageId, filename);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ filePath, filename }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });
}
