/**
 * MCP Tools — Gmail email reading & PDF menu processing
 *
 * sq_list_emails: List recent unread emails from Gmail inbox
 * sq_read_email: Read full email content by message ID
 * sq_process_email: Run full task extraction pipeline on an email
 * sq_download_attachment: Download an email attachment to disk
 * sq_list_processed_emails: Query stored/processed email history from DB
 * sq_parse_pdf_menu: Download PDF attachment, extract text, parse as menu
 */

import { readFileSync } from 'fs';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerGmailTools(server: McpServer) {
  // ── sq_list_emails ──────────────────────────────────────────────────────────
  server.registerTool('sq_list_emails', {
    description:
      'List recent unread emails from the Gmail inbox. Returns summary info (no body) for each message. Use sq_read_email to get full content.',
    inputSchema: {
      limit: z.number().optional().describe('Max emails to return (default 10)'),
    },
  }, async ({ limit }) => {
    try {
      const { fetchNewMessages } = await import('../../services/gmail.js');
      const messages = await fetchNewMessages();
      const maxResults = limit ?? 10;

      const summaries = messages.slice(0, maxResults).map((m) => ({
        id: m.id,
        threadId: m.threadId,
        from: m.from,
        fromName: m.fromName,
        subject: m.subject,
        date: m.date,
        attachmentCount: m.attachments.length,
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
      'Read the full content of an email by its Gmail message ID. Returns complete message including body and attachment metadata.',
    inputSchema: {
      messageId: z.string().describe('Gmail message ID'),
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
      'Download an email attachment to disk. Returns the local file path where the attachment was saved.',
    inputSchema: {
      messageId: z.string().describe('Gmail message ID'),
      attachmentId: z.string().describe('Attachment ID (from sq_read_email attachments array)'),
      filename: z.string().describe('Filename to save as'),
    },
  }, async ({ messageId, attachmentId, filename }) => {
    try {
      const { downloadAttachment } = await import('../../services/gmail.js');
      const filePath = await downloadAttachment(messageId, attachmentId, filename);

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
      'If parsing fails, returns the raw extracted text for manual formatting.',
    inputSchema: {
      messageId: z.string().describe('Gmail message ID'),
      attachmentId: z.string().describe('Attachment ID for the PDF'),
      filename: z.string().describe('PDF filename'),
    },
  }, async ({ messageId, attachmentId, filename }) => {
    try {
      const { downloadAttachment } = await import('../../services/gmail.js');
      const { extractPdfText } = await import('../../services/pdf-extractor.js');
      const { parseMenuText } = await import('../../services/menu-parser.js');

      // Download the PDF
      const filePath = await downloadAttachment(messageId, attachmentId, filename);

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
