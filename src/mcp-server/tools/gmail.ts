/**
 * MCP Tools — Gmail email reading, processing & PDF menu parsing
 *
 * sq_setup_gmail: Interactive OAuth setup — generates auth URL, captures token via callback
 * sq_list_emails: List inbox emails with optional query/limit
 * sq_read_email: Read full email content by message ID (includes attachmentIds)
 * sq_process_email: Run full task extraction pipeline on an email
 * sq_download_attachment: Download an email attachment to disk
 * sq_list_processed_emails: Query stored/processed email history from DB
 * sq_parse_pdf_menu: Download PDF attachment, extract text, parse as menu
 */

import { readFileSync, readFileSync as readSync, writeFileSync } from 'fs';
import { createServer, Server } from 'http';
import { URL } from 'url';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const ENV_PATH = join(PROJECT_ROOT, '.env');
const OAUTH_PORT = 3456; // Avoid 3000/3001 which may be in use

// Shared state for the OAuth callback server
let oauthServer: Server | null = null;
let capturedRefreshToken: string | null = null;

/**
 * Update or append a key=value in the .env file.
 */
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
  // Also set in current process so it takes effect immediately
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
      // Save client credentials if provided
      if (clientId) upsertEnvVar('GMAIL_CLIENT_ID', clientId);
      if (clientSecret) upsertEnvVar('GMAIL_CLIENT_SECRET', clientSecret);

      const envClientId = process.env.GMAIL_CLIENT_ID;
      const envClientSecret = process.env.GMAIL_CLIENT_SECRET;
      const envRefreshToken = process.env.GMAIL_REFRESH_TOKEN;

      // Check if a token was captured by the callback server
      if (capturedRefreshToken) {
        upsertEnvVar('GMAIL_REFRESH_TOKEN', capturedRefreshToken);
        const token = capturedRefreshToken;
        capturedRefreshToken = null;
        // Shut down the OAuth server
        if (oauthServer) { oauthServer.close(); oauthServer = null; }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            status: 'configured',
            message: 'Gmail OAuth token captured and saved. Gmail API is now ready to use.',
          }, null, 2) }],
        };
      }

      // If fully configured and not forcing reauth, test the connection
      if (envClientId && envClientSecret && envRefreshToken && !reauth) {
        try {
          // Reset cached client so it picks up new credentials
          const gmail = await import('../../services/gmail.js');
          // @ts-ignore - reset the cached client to force re-init
          if (gmail.resetClient) gmail.resetClient();
          const { getGmailClient } = gmail;
          const client = getGmailClient();
          const profile = await client.users.getProfile({ userId: 'me' });
          const email = profile.data.emailAddress;

          // Clean up any leftover OAuth server
          if (oauthServer) { oauthServer.close(); oauthServer = null; }

          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              status: 'connected',
              email,
              message: `Gmail API is connected and working. Authorized as ${email}.`,
            }, null, 2) }],
          };
        } catch (err) {
          // Token might be expired/revoked, fall through to re-auth
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

      // Need client credentials to proceed
      if (!envClientId || !envClientSecret) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            status: 'needs_credentials',
            message: 'Gmail OAuth client credentials are not configured.',
            instructions: [
              '1. Go to https://console.cloud.google.com/',
              '2. Create a project (or select existing) and enable the Gmail API',
              '3. Go to APIs & Services → Credentials → Create Credentials → OAuth client ID',
              '4. Application type: Web application',
              `5. Add authorized redirect URI: http://localhost:${OAUTH_PORT}/oauth2callback`,
              '6. Call this tool again with clientId and clientSecret parameters',
            ],
          }, null, 2) }],
        };
      }

      // Start OAuth flow — generate URL and start callback server
      const { google } = await import('googleapis');
      const oauth2Client = new google.auth.OAuth2(
        envClientId,
        envClientSecret,
        `http://localhost:${OAUTH_PORT}/oauth2callback`,
      );

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/gmail.modify',
        ],
        prompt: 'consent',
      });

      // Start callback server if not already running
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
                // Save immediately so it persists even if tool isn't called again
                upsertEnvVar('GMAIL_REFRESH_TOKEN', tokens.refresh_token);
                process.env.GMAIL_REFRESH_TOKEN = tokens.refresh_token;
              }

              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end(
                '<h1>Gmail authorized successfully!</h1>' +
                '<p>You can close this window and go back to Claude Desktop.</p>' +
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

  // ── sq_list_emails ──────────────────────────────────────────────────────────
  server.registerTool('sq_list_emails', {
    description:
      'List emails from the connected Gmail inbox. Returns summary info (id, from, subject, date, attachment count) for each message. ' +
      'Use sq_read_email to get full content and attachment IDs.',
    inputSchema: {
      query: z.string().optional().describe('Gmail search query (default "in:inbox"). Examples: "is:unread", "from:client@example.com", "subject:menu"'),
      limit: z.number().optional().describe('Max emails to return (default 10)'),
    },
  }, async ({ query, limit }) => {
    try {
      const { listInboxMessages } = await import('../../services/gmail.js');
      const messages = await listInboxMessages({ query, maxResults: limit });

      const summaries = messages.map((m) => ({
        id: m.id,
        threadId: m.threadId,
        from: m.from,
        fromName: m.fromName,
        subject: m.subject,
        date: m.date,
        attachmentCount: m.attachments.length,
        attachments: m.attachments.map((a) => ({
          filename: a.filename,
          mimeType: a.mimeType,
          size: a.size,
        })),
      }));

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(summaries, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_read_email ───────────────────────────────────────────────────────────
  server.registerTool('sq_read_email', {
    description:
      'Read the full content of an email by its Gmail message ID. Returns complete message including body text, HTML, and attachment metadata with attachmentIds needed for sq_download_attachment and sq_parse_pdf_menu.',
    inputSchema: {
      messageId: z.string().describe('Gmail message ID (from sq_list_emails)'),
    },
  }, async ({ messageId }) => {
    try {
      const { fetchMessage } = await import('../../services/gmail.js');
      const message = await fetchMessage(messageId);

      if (!message) {
        return {
          content: [{ type: 'text' as const, text: `Error: Email with messageId ${messageId} not found` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(message, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_process_email ────────────────────────────────────────────────────────
  server.registerTool('sq_process_email', {
    description:
      'Run the full task extraction pipeline on an email. Parses the email, extracts tasks via Claude, and stores results in the database.',
    inputSchema: {
      messageId: z.string().describe('Gmail message ID to process'),
    },
  }, async ({ messageId }) => {
    try {
      const { fetchMessage } = await import('../../services/gmail.js');
      const { processEmail } = await import('../../services/email-processor.js');

      const message = await fetchMessage(messageId);
      if (!message) {
        return {
          content: [{ type: 'text' as const, text: `Error: Email with messageId ${messageId} not found` }],
          isError: true,
        };
      }

      const result = await processEmail(message);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
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

      // Resolve attachmentId by filename if not provided
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

  // ── sq_list_processed_emails ────────────────────────────────────────────────
  server.registerTool('sq_list_processed_emails', {
    description:
      'Query stored email history from the database. Filter by processing status to find processed, unprocessed, or all emails.',
    inputSchema: {
      limit: z.number().optional().describe('Max emails to return (default 20)'),
      status: z.enum(['processed', 'unprocessed', 'all']).optional().describe('Filter by processing status (default all)'),
    },
  }, async ({ limit, status }) => {
    try {
      const { listEmails } = await import('../../db/emails.js');
      const emails = listEmails({ limit: limit ?? 20, status: status ?? 'all' });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ emails, total: emails.length }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_parse_pdf_menu ───────────────────────────────────────────────────────
  server.registerTool('sq_parse_pdf_menu', {
    description:
      'Download a PDF attachment, extract text, and attempt to parse it as a Squarespace menu. ' +
      'If parsing succeeds, returns structured MenuTab[] JSON ready for sq_update_menu. ' +
      'If parsing fails, returns the raw extracted text for manual formatting. ' +
      'attachmentId is optional — if omitted, the tool resolves the attachment by filename.',
    inputSchema: {
      messageId: z.string().describe('Gmail message ID'),
      filename: z.string().describe('PDF filename'),
      attachmentId: z.string().optional().describe('Attachment ID for the PDF (resolved by filename if omitted)'),
    },
  }, async ({ messageId, filename, attachmentId }) => {
    try {
      const { downloadAttachment, resolveAttachment } = await import('../../services/gmail.js');
      const { extractPdfText } = await import('../../services/pdf-extractor.js');
      const { parseMenuText } = await import('../../services/menu-parser.js');

      // Resolve attachmentId by filename if not provided
      let resolvedAttachmentId = attachmentId;
      if (!resolvedAttachmentId) {
        const att = await resolveAttachment(messageId, filename);
        resolvedAttachmentId = att.attachmentId;
      }

      // Download the PDF
      const filePath = await downloadAttachment(messageId, resolvedAttachmentId, filename);

      // Read and extract text
      const buffer = readFileSync(filePath);
      const { text: rawText, numPages } = await extractPdfText(buffer);

      // Try to parse as menu
      const menus = parseMenuText(rawText);

      if (menus.length > 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ parsed: true, menus, numPages }, null, 2) }],
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ parsed: false, rawText, numPages }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });
}
