import { logger } from '../utils/logger.js';
import type { GmailMessage, GmailAttachment } from './gmail.js';

export interface ParsedEmail {
  /** Gmail message ID */
  messageId: string;
  threadId: string;

  /** Direct sender (likely Tim who forwarded it) */
  forwarderEmail: string;
  forwarderName?: string;

  /** Original sender (extracted from forwarded email body) */
  originalSenderEmail?: string;
  originalSenderName?: string;

  /** Email subject (with "Fwd:" stripped) */
  subject: string;

  /** Clean email body text (with forward headers stripped) */
  bodyText: string;

  /** Original raw body */
  rawBodyText: string;
  rawBodyHtml: string;

  /** Received timestamp */
  receivedAt: string;

  /** Attachments */
  attachments: GmailAttachment[];
}

/**
 * Parse a Gmail message, extracting the original sender from forwarded emails
 * and cleaning up the body text.
 *
 * Tim forwards client emails to the agent. A typical forwarded email looks like:
 *
 *   From: Tim Cox <tim@example.com>
 *   Subject: Fwd: Updated menus for Smyth
 *   Body:
 *     ---------- Forwarded message ----------
 *     From: Dawn <dawn@smythtavern.com>
 *     Date: Wed, Feb 12, 2026
 *     Subject: Updated menus for Smyth
 *     To: Tim Cox <tim@example.com>
 *
 *     Hi Tim, here are the updated menus...
 */
export function parseEmail(message: GmailMessage): ParsedEmail {
  // Extract the forwarder (direct sender — usually Tim)
  const { email: forwarderEmail, name: forwarderName } = parseEmailAddress(message.from);

  // Clean subject — strip "Fwd:" / "FW:" / "Re:" prefixes
  const subject = cleanSubject(message.subject);

  // Try to extract original sender from forwarded email body
  const { originalSenderEmail, originalSenderName, cleanBody } = extractForwardedInfo(
    message.bodyText || stripHtml(message.bodyHtml),
  );

  return {
    messageId: message.id,
    threadId: message.threadId,
    forwarderEmail,
    forwarderName,
    originalSenderEmail,
    originalSenderName,
    subject,
    bodyText: cleanBody,
    rawBodyText: message.bodyText,
    rawBodyHtml: message.bodyHtml,
    receivedAt: message.date,
    attachments: message.attachments,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseEmailAddress(raw: string): { email: string; name?: string } {
  // Handle "Name <email@domain.com>" format
  const match = raw.match(/^"?([^"<]*?)"?\s*<?([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})>?$/);
  if (match) {
    return {
      name: match[1]?.trim() || undefined,
      email: match[2].toLowerCase(),
    };
  }
  // Plain email
  return { email: raw.trim().toLowerCase() };
}

function cleanSubject(subject: string): string {
  return subject
    .replace(/^(fwd?|fw|re):\s*/gi, '') // Strip Fwd:/FW:/Re: prefix
    .replace(/^(fwd?|fw|re):\s*/gi, '') // Strip again in case of "Fwd: Re:"
    .trim();
}

/**
 * Extract original sender info from forwarded email body.
 * Handles common forwarding formats:
 *
 * Gmail:
 *   ---------- Forwarded message ----------
 *   From: Dawn <dawn@smythtavern.com>
 *   Date: ...
 *
 * Outlook:
 *   -----Original Message-----
 *   From: Dawn <dawn@smythtavern.com>
 *
 * Apple Mail:
 *   Begin forwarded message:
 *   From: Dawn <dawn@smythtavern.com>
 */
function extractForwardedInfo(bodyText: string): {
  originalSenderEmail?: string;
  originalSenderName?: string;
  cleanBody: string;
} {
  let originalSenderEmail: string | undefined;
  let originalSenderName: string | undefined;
  let cleanBody = bodyText;

  // Pattern 1: Gmail forward header
  const gmailForwardPattern =
    /[-]{5,}\s*Forwarded message\s*[-]{5,}\s*\n([\s\S]*?)(?=\n\n|\n(?!From:|Date:|Subject:|To:|Cc:))/i;

  // Pattern 2: Outlook forward header
  const outlookForwardPattern =
    /[-]{5,}\s*Original Message\s*[-]{5,}\s*\n([\s\S]*?)(?=\n\n|\n(?!From:|Date:|Subject:|To:|Cc:))/i;

  // Pattern 3: Apple Mail forward header
  const appleForwardPattern =
    /Begin forwarded message:\s*\n([\s\S]*?)(?=\n\n|\n(?!From:|Date:|Subject:|To:|Cc:))/i;

  const forwardMatch =
    bodyText.match(gmailForwardPattern) ||
    bodyText.match(outlookForwardPattern) ||
    bodyText.match(appleForwardPattern);

  if (forwardMatch) {
    const headerBlock = forwardMatch[1];

    // Extract "From:" line from the forward headers
    const fromMatch = headerBlock.match(/From:\s*(.+)/i);
    if (fromMatch) {
      const parsed = parseEmailAddress(fromMatch[1].trim());
      originalSenderEmail = parsed.email;
      originalSenderName = parsed.name;
    }

    // Clean body: extract just the forwarded message content (after the headers)
    const forwardHeaderEnd = bodyText.indexOf(forwardMatch[0]) + forwardMatch[0].length;
    // Find the next blank line after the headers
    const contentStart = bodyText.indexOf('\n\n', forwardHeaderEnd);
    if (contentStart !== -1) {
      cleanBody = bodyText.substring(contentStart).trim();
    }
  }

  // If no forward headers found, try a simpler "From:" pattern at the start
  if (!originalSenderEmail) {
    const simpleFromMatch = bodyText.match(
      /(?:^|\n)From:\s*"?([^"<\n]*?)"?\s*<?([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})>?/i,
    );
    if (simpleFromMatch) {
      originalSenderName = simpleFromMatch[1]?.trim() || undefined;
      originalSenderEmail = simpleFromMatch[2]?.toLowerCase();
    }
  }

  logger.debug(
    {
      originalSenderEmail,
      originalSenderName,
      bodyLength: cleanBody.length,
      hasForwardHeaders: !!forwardMatch,
    },
    'Parsed forwarded email',
  );

  return { originalSenderEmail, originalSenderName, cleanBody };
}

/**
 * Basic HTML to text conversion for when only HTML body is available.
 */
function stripHtml(html: string): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
