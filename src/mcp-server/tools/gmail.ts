/**
 * MCP Tools — Gmail OAuth2 login + attachment download
 *
 * sq_login_gmail: OAuth2 flow — opens user's real browser, local callback server
 * sq_download_attachment: Download email attachment via Gmail API
 *
 * Search/read handled by Claude.ai Gmail MCP — we only fill the attachment gap.
 */

import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import http from 'http';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const AUTH_DIR = join(PROJECT_ROOT, 'storage', 'auth');

const SCOPES = 'https://www.googleapis.com/auth/gmail.readonly';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export function registerGmailTools(server: McpServer) {
  // ── sq_login_gmail ─────────────────────────────────────────────────────────
  server.registerTool('sq_login_gmail', {
    description:
      'Authorize Gmail access via Google OAuth2. Opens your default browser for Google login. ' +
      'Requires GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env ' +
      'from a Google Cloud project with the Gmail API enabled (Desktop app type).',
    inputSchema: {
      timeoutMs: z.number().optional().describe(
        'Max milliseconds to wait for authorization (default 120000)',
      ),
    },
  }, async ({ timeoutMs }) => {
    const timeout = timeoutMs ?? 120_000;
    let httpServer: http.Server | null = null;

    try {
      const { loadCredentials, saveTokens } = await import('../../services/gmail.js');
      const creds = loadCredentials();

      // Start local HTTP server on random port
      const { port, code } = await new Promise<{ port: number; code: string }>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          if (httpServer) httpServer.close();
          reject(new Error('timeout'));
        }, timeout);

        httpServer = http.createServer((req, res) => {
          const url = new URL(req.url!, `http://localhost`);
          const authCode = url.searchParams.get('code');
          const error = url.searchParams.get('error');

          if (error) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<h1>Authorization denied</h1><p>You can close this tab.</p>');
            clearTimeout(timeoutId);
            httpServer!.close();
            reject(new Error(`OAuth denied: ${error}`));
            return;
          }

          if (authCode) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<h1>Gmail authorized!</h1><p>You can close this tab and return to Claude.</p>');
            clearTimeout(timeoutId);
            httpServer!.close();
            resolve({ port: (httpServer!.address() as any).port, code: authCode });
            return;
          }

          res.writeHead(404);
          res.end();
        });

        httpServer.listen(0, '127.0.0.1', () => {
          const addr = httpServer!.address() as { port: number };
          const redirectUri = `http://127.0.0.1:${addr.port}`;

          const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
          authUrl.searchParams.set('client_id', creds.client_id);
          authUrl.searchParams.set('redirect_uri', redirectUri);
          authUrl.searchParams.set('response_type', 'code');
          authUrl.searchParams.set('scope', SCOPES);
          authUrl.searchParams.set('access_type', 'offline');
          authUrl.searchParams.set('prompt', 'consent');

          // Open user's real browser (not Playwright)
          try {
            execSync(`open "${authUrl.toString()}"`);
          } catch {
            reject(new Error(`Could not open browser. Visit this URL manually:\n${authUrl.toString()}`));
          }
        });
      });

      // Exchange auth code for tokens
      const redirectUri = `http://127.0.0.1:${port}`;
      const tokenResponse = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: creds.client_id,
          client_secret: creds.client_secret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });

      if (!tokenResponse.ok) {
        const body = await tokenResponse.text();
        throw new Error(`Token exchange failed (${tokenResponse.status}): ${body}`);
      }

      const tokenData = await tokenResponse.json() as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
      };

      mkdirSync(AUTH_DIR, { recursive: true });
      saveTokens({
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expiry: Date.now() + tokenData.expires_in * 1000,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          status: 'authorized',
          hasRefreshToken: !!tokenData.refresh_token,
          message: 'Gmail OAuth2 authorized. Attachment downloads are now ready. Token will auto-refresh.',
        }, null, 2) }],
      };
    } catch (err) {
      if (httpServer) {
        try { httpServer.close(); } catch { /* best effort */ }
      }

      const msg = err instanceof Error ? err.message : String(err);

      if (msg === 'timeout') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            status: 'timeout',
            message: `Authorization timed out after ${timeout}ms. Please try again.`,
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
      'Download an email attachment via Gmail API. Returns the local file path. ' +
      'Requires sq_login_gmail to have been run first for OAuth2 authorization.',
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
