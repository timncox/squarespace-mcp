/**
 * MCP Tools — Gmail attachment download
 *
 * sq_setup_gmail: OAuth setup for Gmail API access
 * sq_download_attachment: Download email attachment to disk
 *
 * Search/read handled by Claude.ai Gmail MCP — we only fill the attachment gap.
 */

import { readFileSync as readSync, writeFileSync } from 'fs';
import { createServer, Server } from 'http';
import { URL } from 'url';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const ENV_PATH = join(PROJECT_ROOT, '.env');
const OAUTH_PORT = 3456;

let oauthServer: Server | null = null;
let capturedRefreshToken: string | null = null;

function upsertEnvVar(key: string, value: string): void {
  let content: string;
  try {
    content = readSync(ENV_PATH, 'utf-8');
  } catch {
    content = '';
  }

  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}\n`;
  }

  writeFileSync(ENV_PATH, content, 'utf-8');
  process.env[key] = value;
}

export function registerGmailTools(server: McpServer) {
  // ── sq_setup_gmail ──────────────────────────────────────────────────────────
  server.registerTool('sq_setup_gmail', {
    description:
      'Set up Gmail API access. If already configured, tests the connection. ' +
      'If not configured, starts an OAuth flow: returns an authorization URL for the user to open in their browser. ' +
      'After authorizing, the token is captured automatically via a local callback server. ' +
      'Call this tool again after authorizing to verify the setup.',
    inputSchema: {
      clientId: z.string().optional().describe('Google OAuth Client ID (if not already in .env)'),
      clientSecret: z.string().optional().describe('Google OAuth Client Secret (if not already in .env)'),
      reauth: z.boolean().optional().describe('Force re-authorization with a different Gmail account (default false)'),
    },
  }, async ({ clientId, clientSecret, reauth }) => {
    try {
      if (clientId) upsertEnvVar('GMAIL_CLIENT_ID', clientId);
      if (clientSecret) upsertEnvVar('GMAIL_CLIENT_SECRET', clientSecret);

      const envClientId = process.env.GMAIL_CLIENT_ID;
      const envClientSecret = process.env.GMAIL_CLIENT_SECRET;
      const envRefreshToken = process.env.GMAIL_REFRESH_TOKEN;

      if (capturedRefreshToken) {
        upsertEnvVar('GMAIL_REFRESH_TOKEN', capturedRefreshToken);
        capturedRefreshToken = null;
        if (oauthServer) { oauthServer.close(); oauthServer = null; }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            status: 'configured',
            message: 'Gmail OAuth token captured and saved. Gmail API is now ready to use.',
          }, null, 2) }],
        };
      }

      if (envClientId && envClientSecret && envRefreshToken && !reauth) {
        try {
          const gmail = await import('../../services/gmail.js');
          if (gmail.resetClient) gmail.resetClient();
          const client = gmail.getGmailClient();
          const profile = await client.users.getProfile({ userId: 'me' });
          const email = profile.data.emailAddress;

          if (oauthServer) { oauthServer.close(); oauthServer = null; }

          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              status: 'connected',
              email,
              message: `Gmail API is connected and working. Authorized as ${email}.`,
            }, null, 2) }],
          };
        } catch (err) {
          const errMessage = err instanceof Error ? err.message : String(err);
          if (!errMessage.includes('not configured')) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({
                status: 'error',
                message: `Gmail credentials are set but connection failed: ${errMessage}. You may need to re-authorize.`,
                hint: 'Call sq_setup_gmail again without arguments to start re-authorization.',
              }, null, 2) }],
            };
          }
        }
      }

      if (!envClientId || !envClientSecret) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            status: 'needs_credentials',
            message: 'Gmail OAuth client credentials are not configured.',
            instructions: [
              '1. Go to https://console.cloud.google.com/',
              '2. Create a project (or select existing) and enable the Gmail API',
              '3. Go to APIs & Services > Credentials > Create Credentials > OAuth client ID',
              '4. Application type: Web application',
              `5. Add authorized redirect URI: http://localhost:${OAUTH_PORT}/oauth2callback`,
              '6. Call this tool again with clientId and clientSecret parameters',
            ],
          }, null, 2) }],
        };
      }

      const { google } = await import('googleapis');
      const oauth2Client = new google.auth.OAuth2(
        envClientId,
        envClientSecret,
        `http://localhost:${OAUTH_PORT}/oauth2callback`,
      );

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/gmail.readonly'],
        prompt: 'consent',
      });

      if (!oauthServer) {
        capturedRefreshToken = null;

        oauthServer = createServer(async (req, res) => {
          const url = new URL(req.url ?? '', `http://localhost:${OAUTH_PORT}`);

          if (url.pathname === '/oauth2callback') {
            const code = url.searchParams.get('code');
            if (!code) {
              res.writeHead(400, { 'Content-Type': 'text/html' });
              res.end('<h1>Error: Missing authorization code</h1>');
              return;
            }

            try {
              const { tokens } = await oauth2Client.getToken(code);
              if (tokens.refresh_token) {
                capturedRefreshToken = tokens.refresh_token;
                upsertEnvVar('GMAIL_REFRESH_TOKEN', tokens.refresh_token);
                process.env.GMAIL_REFRESH_TOKEN = tokens.refresh_token;
              }

              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end(
                '<h1>Gmail authorized successfully!</h1>' +
                '<p>You can close this window and go back to Claude.</p>' +
                '<p>The refresh token has been saved automatically.</p>',
              );
            } catch (err) {
              res.writeHead(500, { 'Content-Type': 'text/html' });
              res.end(`<h1>Error exchanging authorization code</h1><p>${err}</p>`);
            }
          } else {
            res.writeHead(404);
            res.end('Not found');
          }
        });

        oauthServer.listen(OAUTH_PORT);
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          status: 'awaiting_authorization',
          authUrl,
          message: 'Open the authorization URL in your browser to connect your Gmail account. After authorizing, call sq_setup_gmail again to verify the connection.',
          instructions: [
            '1. Open the authUrl link in your browser',
            '2. Sign in with your Google account and authorize access',
            '3. You\'ll see a "Gmail authorized successfully!" page',
            '4. Come back here and call sq_setup_gmail to confirm it worked',
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

  // ── sq_download_attachment ──────────────────────────────────────────────────
  server.registerTool('sq_download_attachment', {
    description:
      'Download an email attachment to disk. Returns the local file path. ' +
      'You can provide attachmentId (from sq_read_email) OR just the filename — ' +
      'if attachmentId is omitted, the tool will look up the attachment by filename.',
    inputSchema: {
      messageId: z.string().describe('Gmail message ID'),
      filename: z.string().describe('Filename to save as (also used to find attachment if attachmentId omitted)'),
      attachmentId: z.string().optional().describe('Attachment ID (from sq_read_email). If omitted, resolved by filename.'),
    },
  }, async ({ messageId, filename, attachmentId }) => {
    try {
      const { downloadAttachment, resolveAttachment } = await import('../../services/gmail.js');

      let resolvedAttachmentId = attachmentId;
      if (!resolvedAttachmentId) {
        const att = await resolveAttachment(messageId, filename);
        resolvedAttachmentId = att.attachmentId;
      }

      const filePath = await downloadAttachment(messageId, resolvedAttachmentId, filename);

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
