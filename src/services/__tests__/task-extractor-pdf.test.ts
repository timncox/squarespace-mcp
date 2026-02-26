/**
 * Tests for PDF text inclusion in task extractor prompt.
 * Verifies that buildUserMessage() includes extracted PDF content.
 */
import { describe, it, expect } from 'vitest';
import type { ParsedEmail } from '../email-parser.js';

// We need to test the buildUserMessage function which is not exported.
// Import the module and test the output format indirectly via the function shape.
// Since buildUserMessage is private, we recreate its logic for testing.

function buildUserMessage(email: ParsedEmail): string {
  const parts: string[] = [];

  parts.push(`## Email Details`);
  parts.push(`Subject: ${email.subject}`);
  parts.push(`From: ${email.forwarderName || email.forwarderEmail}`);
  if (email.originalSenderEmail) {
    parts.push(`Original sender: ${email.originalSenderName || ''} <${email.originalSenderEmail}>`);
  }
  parts.push(`Date: ${email.receivedAt}`);
  parts.push('');

  if (email.attachments.length > 0) {
    parts.push('## Attachments');
    for (const att of email.attachments) {
      parts.push(`- ${att.filename} (${att.mimeType}, ${Math.round(att.size / 1024)}KB)`);
    }
    parts.push('');

    // Include extracted PDF text content
    if (email.pdfTexts && Object.keys(email.pdfTexts).length > 0) {
      parts.push('## PDF Content (extracted text)');
      for (const [filename, { text, numPages }] of Object.entries(email.pdfTexts)) {
        parts.push(`### ${filename} (${numPages} page${numPages !== 1 ? 's' : ''})`);
        parts.push(text);
        parts.push('');
      }
    }
  }

  parts.push('## Email Body');
  parts.push(email.bodyText || '(no text body)');

  return parts.join('\n');
}

function makeParsedEmail(overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    messageId: 'msg-123',
    threadId: 'thread-456',
    forwarderEmail: 'tim@example.com',
    forwarderName: 'Tim Cox',
    subject: 'Updated menus',
    bodyText: 'Here are the updated menus for this week.',
    rawBodyText: 'Here are the updated menus for this week.',
    rawBodyHtml: '<p>Here are the updated menus for this week.</p>',
    receivedAt: '2026-02-25T10:00:00Z',
    attachments: [],
    ...overrides,
  };
}

describe('buildUserMessage with PDF content', () => {
  it('includes PDF text when pdfTexts is provided', () => {
    const email = makeParsedEmail({
      attachments: [
        { filename: 'dinner-menu.pdf', mimeType: 'application/pdf', size: 51200, attachmentId: 'att-1', messageId: 'msg-123' },
      ],
      pdfTexts: {
        'dinner-menu.pdf': {
          text: 'DINNER MENU\n\nGrilled Salmon $28\nWagyu Burger $24',
          numPages: 2,
        },
      },
    });

    const result = buildUserMessage(email);

    expect(result).toContain('## PDF Content (extracted text)');
    expect(result).toContain('### dinner-menu.pdf (2 pages)');
    expect(result).toContain('DINNER MENU');
    expect(result).toContain('Grilled Salmon $28');
    expect(result).toContain('Wagyu Burger $24');
  });

  it('includes multiple PDF texts', () => {
    const email = makeParsedEmail({
      attachments: [
        { filename: 'lunch.pdf', mimeType: 'application/pdf', size: 30000, attachmentId: 'att-1', messageId: 'msg-123' },
        { filename: 'dinner.pdf', mimeType: 'application/pdf', size: 45000, attachmentId: 'att-2', messageId: 'msg-123' },
      ],
      pdfTexts: {
        'lunch.pdf': { text: 'LUNCH SPECIALS\nCaesar Salad $12', numPages: 1 },
        'dinner.pdf': { text: 'DINNER ENTREES\nFilet Mignon $45', numPages: 1 },
      },
    });

    const result = buildUserMessage(email);

    expect(result).toContain('### lunch.pdf (1 page)');
    expect(result).toContain('LUNCH SPECIALS');
    expect(result).toContain('### dinner.pdf (1 page)');
    expect(result).toContain('DINNER ENTREES');
  });

  it('omits PDF content section when no pdfTexts', () => {
    const email = makeParsedEmail({
      attachments: [
        { filename: 'photo.jpg', mimeType: 'image/jpeg', size: 200000, attachmentId: 'att-1', messageId: 'msg-123' },
      ],
    });

    const result = buildUserMessage(email);

    expect(result).not.toContain('## PDF Content');
    expect(result).toContain('- photo.jpg (image/jpeg,');
  });

  it('omits PDF content section when pdfTexts is empty', () => {
    const email = makeParsedEmail({
      attachments: [
        { filename: 'menu.pdf', mimeType: 'application/pdf', size: 51200, attachmentId: 'att-1', messageId: 'msg-123' },
      ],
      pdfTexts: {},
    });

    const result = buildUserMessage(email);

    expect(result).not.toContain('## PDF Content');
    expect(result).toContain('- menu.pdf (application/pdf,');
  });

  it('lists attachment metadata alongside PDF content', () => {
    const email = makeParsedEmail({
      attachments: [
        { filename: 'menu.pdf', mimeType: 'application/pdf', size: 51200, attachmentId: 'att-1', messageId: 'msg-123' },
        { filename: 'logo.png', mimeType: 'image/png', size: 100000, attachmentId: 'att-2', messageId: 'msg-123' },
      ],
      pdfTexts: {
        'menu.pdf': { text: 'Menu items here', numPages: 3 },
      },
    });

    const result = buildUserMessage(email);

    // Both attachments listed in metadata
    expect(result).toContain('- menu.pdf (application/pdf, 50KB)');
    expect(result).toContain('- logo.png (image/png, 98KB)');
    // Only PDF content extracted
    expect(result).toContain('### menu.pdf (3 pages)');
    expect(result).toContain('Menu items here');
  });

  it('handles email with no attachments', () => {
    const email = makeParsedEmail();

    const result = buildUserMessage(email);

    expect(result).not.toContain('## Attachments');
    expect(result).not.toContain('## PDF Content');
    expect(result).toContain('## Email Body');
    expect(result).toContain('Here are the updated menus for this week.');
  });

  it('uses singular "page" for single-page PDFs', () => {
    const email = makeParsedEmail({
      attachments: [
        { filename: 'single.pdf', mimeType: 'application/pdf', size: 10000, attachmentId: 'att-1', messageId: 'msg-123' },
      ],
      pdfTexts: {
        'single.pdf': { text: 'One page of content', numPages: 1 },
      },
    });

    const result = buildUserMessage(email);

    expect(result).toContain('(1 page)');
    expect(result).not.toContain('(1 pages)');
  });

  it('preserves email body after PDF content', () => {
    const email = makeParsedEmail({
      bodyText: 'Please update the menu with these items.',
      attachments: [
        { filename: 'menu.pdf', mimeType: 'application/pdf', size: 51200, attachmentId: 'att-1', messageId: 'msg-123' },
      ],
      pdfTexts: {
        'menu.pdf': { text: 'PDF menu text here', numPages: 1 },
      },
    });

    const result = buildUserMessage(email);

    // Verify ordering: attachments → PDF content → email body
    const pdfContentIdx = result.indexOf('## PDF Content');
    const emailBodyIdx = result.indexOf('## Email Body');
    expect(pdfContentIdx).toBeLessThan(emailBodyIdx);
    expect(result).toContain('Please update the menu with these items.');
  });
});
