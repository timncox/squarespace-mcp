# Gmail MCP Tools Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expose Gmail email reading, processing, and PDF menu parsing as 6 MCP tools.

**Architecture:** New `src/mcp-server/tools/gmail.ts` module wrapping existing `gmail.ts`, `email-processor.ts`, `pdf-extractor.ts`, and `menu-parser.ts` services. One new DB query function in `emails.ts` for filtered listing. Follows the established `registerXxxTools` pattern.

**Tech Stack:** Zod 3, MCP SDK, existing Gmail/PDF/menu services, SQLite via better-sqlite3.

---

### Task 1: Add `listEmails` DB query function

**Files:**
- Modify: `src/db/emails.ts`
- Test: `src/db/__tests__/emails.test.ts` (create if doesn't exist)

**Step 1: Write the failing test**

Create `src/db/__tests__/emails.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock database module
const mockAll = vi.fn();
const mockPrepare = vi.fn(() => ({ all: mockAll }));
vi.mock('../database.js', () => ({
  getDb: vi.fn(() => ({ prepare: mockPrepare })),
}));

import { listEmails } from '../emails.js';

describe('listEmails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should list all emails with default limit', () => {
    mockAll.mockReturnValue([
      { id: '1', gmail_message_id: 'gm-1', from_address: 'a@b.com', subject: 'Test', received_at: '2026-01-01', created_at: '2026-01-01' },
    ]);

    const result = listEmails();
    expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('ORDER BY received_at DESC'));
    expect(mockAll).toHaveBeenCalledWith(20);
    expect(result).toHaveLength(1);
    expect(result[0].gmailMessageId).toBe('gm-1');
  });

  it('should filter by processed status', () => {
    mockAll.mockReturnValue([]);

    listEmails({ status: 'processed' });
    expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('processed_at IS NOT NULL'));
  });

  it('should filter by unprocessed status', () => {
    mockAll.mockReturnValue([]);

    listEmails({ status: 'unprocessed' });
    expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('processed_at IS NULL'));
  });

  it('should respect custom limit', () => {
    mockAll.mockReturnValue([]);

    listEmails({ limit: 5 });
    expect(mockAll).toHaveBeenCalledWith(5);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/__tests__/emails.test.ts`
Expected: FAIL — `listEmails` is not exported.

**Step 3: Write minimal implementation**

Add to `src/db/emails.ts`:

```typescript
export function listEmails(options?: { limit?: number; status?: 'processed' | 'unprocessed' | 'all' }): StoredEmail[] {
  const db = getDb();
  const limit = options?.limit ?? 20;
  const status = options?.status ?? 'all';

  let whereClause = '';
  if (status === 'processed') whereClause = 'WHERE processed_at IS NOT NULL';
  else if (status === 'unprocessed') whereClause = 'WHERE processed_at IS NULL';

  const rows = db.prepare(
    `SELECT * FROM emails ${whereClause} ORDER BY received_at DESC LIMIT ?`,
  ).all(limit) as Record<string, unknown>[];
  return rows.map(rowToEmail);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/db/__tests__/emails.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/db/emails.ts src/db/__tests__/emails.test.ts
git commit -m "feat: add listEmails query function with status filter"
```

---

### Task 2: Create Gmail MCP tool module with `sq_list_emails`

**Files:**
- Create: `src/mcp-server/tools/gmail.ts`
- Create: `src/mcp-server/__tests__/gmail-tools.test.ts`

**Step 1: Write the failing test**

Create `src/mcp-server/__tests__/gmail-tools.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock gmail service
const mockFetchNewMessages = vi.fn();
const mockFetchMessage = vi.fn();
const mockDownloadAttachment = vi.fn();
const mockMarkAsRead = vi.fn();

vi.mock('../../services/gmail.js', () => ({
  fetchNewMessages: mockFetchNewMessages,
  fetchMessage: mockFetchMessage,
  downloadAttachment: mockDownloadAttachment,
  markAsRead: mockMarkAsRead,
}));

// Mock email-processor
const mockProcessEmail = vi.fn();
vi.mock('../../services/email-processor.js', () => ({
  processEmail: mockProcessEmail,
}));

// Mock pdf-extractor
const mockExtractPdfText = vi.fn();
vi.mock('../../services/pdf-extractor.js', () => ({
  extractPdfText: mockExtractPdfText,
}));

// Mock menu-parser
const mockParseMenuText = vi.fn();
vi.mock('../../services/menu-parser.js', () => ({
  parseMenuText: mockParseMenuText,
}));

// Mock db/emails
const mockListEmails = vi.fn();
vi.mock('../../db/emails.js', () => ({
  listEmails: mockListEmails,
}));

import { registerGmailTools } from '../tools/gmail.js';

function createMockServer() {
  const tools = new Map<string, { config: any; handler: Function }>();
  return {
    registerTool: vi.fn((name: string, config: any, handler: Function) => {
      tools.set(name, { config, handler });
    }),
    tools,
    callTool: async (name: string, params: any) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} not registered`);
      return tool.handler(params);
    },
  };
}

describe('Gmail Tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerGmailTools(server as any);
  });

  it('should register all 6 gmail tools', () => {
    expect(server.tools.has('sq_list_emails')).toBe(true);
    expect(server.tools.has('sq_read_email')).toBe(true);
    expect(server.tools.has('sq_process_email')).toBe(true);
    expect(server.tools.has('sq_download_attachment')).toBe(true);
    expect(server.tools.has('sq_list_processed_emails')).toBe(true);
    expect(server.tools.has('sq_parse_pdf_menu')).toBe(true);
  });

  // ── sq_list_emails ────────────────────────────────────────────────────────

  describe('sq_list_emails', () => {
    it('should list unread emails with defaults', async () => {
      mockFetchNewMessages.mockResolvedValue([
        { id: 'gm-1', threadId: 'th-1', from: 'client@test.com', fromName: 'Client', subject: 'Update menu', date: '2026-03-04', bodyText: '', bodyHtml: '', attachments: [] },
      ]);

      const result = await server.callTool('sq_list_emails', {});
      expect(mockFetchNewMessages).toHaveBeenCalled();
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.emails).toHaveLength(1);
      expect(data.emails[0].subject).toBe('Update menu');
    });

    it('should respect limit param', async () => {
      mockFetchNewMessages.mockResolvedValue([
        { id: 'gm-1', threadId: 'th-1', from: 'a@b.com', subject: 'Test 1', date: '2026-03-04', bodyText: '', bodyHtml: '', attachments: [] },
        { id: 'gm-2', threadId: 'th-2', from: 'c@d.com', subject: 'Test 2', date: '2026-03-04', bodyText: '', bodyHtml: '', attachments: [] },
      ]);

      const result = await server.callTool('sq_list_emails', { limit: 1 });
      const data = JSON.parse(result.content[0].text);
      expect(data.emails).toHaveLength(1);
    });

    it('should return error on Gmail failure', async () => {
      mockFetchNewMessages.mockRejectedValue(new Error('Gmail API error'));

      const result = await server.callTool('sq_list_emails', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Gmail API error');
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/mcp-server/__tests__/gmail-tools.test.ts`
Expected: FAIL — module `../tools/gmail.js` not found.

**Step 3: Write minimal implementation**

Create `src/mcp-server/tools/gmail.ts`:

```typescript
/**
 * MCP Tools — Gmail
 *
 * sq_list_emails: List recent emails from inbox
 * sq_read_email: Read a specific email's full content
 * sq_process_email: Trigger task extraction pipeline on an email
 * sq_download_attachment: Download an email attachment
 * sq_list_processed_emails: Query processed email history from DB
 * sq_parse_pdf_menu: Extract text from PDF attachment and parse as menu
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fetchNewMessages, fetchMessage, downloadAttachment } from '../../services/gmail.js';

export function registerGmailTools(server: McpServer) {
  // ── sq_list_emails ─────────────────────────────────────────────────────────
  server.registerTool('sq_list_emails', {
    description:
      'List recent emails from the Gmail inbox. Returns email summaries (id, from, subject, date, attachment count). Use sq_read_email to get full content.',
    inputSchema: {
      limit: z.number().optional().describe('Max emails to return (default: 10)'),
      unreadOnly: z.boolean().optional().describe('Only unread messages (default: true)'),
    },
  }, async ({ limit, unreadOnly }) => {
    try {
      const maxResults = limit ?? 10;
      const messages = await fetchNewMessages();

      // Slice to limit
      const sliced = messages.slice(0, maxResults);

      // Return summaries (strip body content for list view)
      const emails = sliced.map((m) => ({
        id: m.id,
        threadId: m.threadId,
        from: m.from,
        fromName: m.fromName,
        subject: m.subject,
        date: m.date,
        attachmentCount: m.attachments.length,
      }));

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
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/mcp-server/__tests__/gmail-tools.test.ts`
Expected: PASS (registration test + sq_list_emails tests)

**Step 5: Commit**

```bash
git add src/mcp-server/tools/gmail.ts src/mcp-server/__tests__/gmail-tools.test.ts
git commit -m "feat: add Gmail MCP tool module with sq_list_emails"
```

---

### Task 3: Add `sq_read_email` tool

**Files:**
- Modify: `src/mcp-server/tools/gmail.ts`
- Modify: `src/mcp-server/__tests__/gmail-tools.test.ts`

**Step 1: Write the failing test**

Add to `gmail-tools.test.ts` inside the `describe('Gmail Tools')` block:

```typescript
  // ── sq_read_email ─────────────────────────────────────────────────────────

  describe('sq_read_email', () => {
    it('should read full email by messageId', async () => {
      mockFetchMessage.mockResolvedValue({
        id: 'gm-1', threadId: 'th-1', from: 'client@test.com', fromName: 'Client',
        subject: 'Please update menu', date: '2026-03-04',
        bodyText: 'Here is the new menu attached.', bodyHtml: '<p>Here is the new menu attached.</p>',
        attachments: [{ filename: 'menu.pdf', mimeType: 'application/pdf', size: 12345, attachmentId: 'att-1', messageId: 'gm-1' }],
      });

      const result = await server.callTool('sq_read_email', { messageId: 'gm-1' });
      expect(mockFetchMessage).toHaveBeenCalledWith('gm-1');
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.subject).toBe('Please update menu');
      expect(data.bodyText).toContain('new menu');
      expect(data.attachments).toHaveLength(1);
      expect(data.attachments[0].filename).toBe('menu.pdf');
    });

    it('should return error when message not found', async () => {
      mockFetchMessage.mockResolvedValue(null);

      const result = await server.callTool('sq_read_email', { messageId: 'bad-id' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });

    it('should return error on Gmail failure', async () => {
      mockFetchMessage.mockRejectedValue(new Error('Token expired'));

      const result = await server.callTool('sq_read_email', { messageId: 'gm-1' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Token expired');
    });
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/mcp-server/__tests__/gmail-tools.test.ts`
Expected: FAIL — `sq_read_email` handler not implemented (or returns wrong result).

**Step 3: Write minimal implementation**

Add to `registerGmailTools` in `gmail.ts`:

```typescript
  // ── sq_read_email ──────────────────────────────────────────────────────────
  server.registerTool('sq_read_email', {
    description:
      'Read a specific email by Gmail message ID. Returns full content: headers, body text, body HTML, and attachment metadata. Use attachment IDs with sq_download_attachment or sq_parse_pdf_menu.',
    inputSchema: {
      messageId: z.string().describe('Gmail message ID (from sq_list_emails)'),
    },
  }, async ({ messageId }) => {
    try {
      const message = await fetchMessage(messageId);
      if (!message) {
        return {
          content: [{ type: 'text' as const, text: `Error: Email with messageId "${messageId}" not found` }],
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
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/mcp-server/__tests__/gmail-tools.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/mcp-server/tools/gmail.ts src/mcp-server/__tests__/gmail-tools.test.ts
git commit -m "feat: add sq_read_email MCP tool"
```

---

### Task 4: Add `sq_process_email` tool

**Files:**
- Modify: `src/mcp-server/tools/gmail.ts`
- Modify: `src/mcp-server/__tests__/gmail-tools.test.ts`

**Step 1: Write the failing test**

Add to `gmail-tools.test.ts`:

```typescript
  // ── sq_process_email ──────────────────────────────────────────────────────

  describe('sq_process_email', () => {
    it('should process email and return tasks', async () => {
      mockFetchMessage.mockResolvedValue({
        id: 'gm-1', threadId: 'th-1', from: 'client@test.com', fromName: 'Client',
        subject: 'Update homepage', date: '2026-03-04',
        bodyText: 'Please update the hero text.', bodyHtml: '', attachments: [],
      });
      mockProcessEmail.mockResolvedValue({
        emailId: 'em-1', subject: 'Update homepage', from: 'client@test.com',
        tasks: [{ id: 'task-1', title: 'Update hero text', status: 'pending' }],
        reasoning: 'Client wants hero text changed',
      });

      const result = await server.callTool('sq_process_email', { messageId: 'gm-1' });
      expect(mockFetchMessage).toHaveBeenCalledWith('gm-1');
      expect(mockProcessEmail).toHaveBeenCalled();
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.tasks).toHaveLength(1);
      expect(data.reasoning).toContain('hero text');
    });

    it('should return error when message not found', async () => {
      mockFetchMessage.mockResolvedValue(null);

      const result = await server.callTool('sq_process_email', { messageId: 'bad-id' });
      expect(result.isError).toBe(true);
    });

    it('should return error on processing failure', async () => {
      mockFetchMessage.mockResolvedValue({
        id: 'gm-1', threadId: 'th-1', from: 'a@b.com', subject: 'X', date: '2026-03-04',
        bodyText: '', bodyHtml: '', attachments: [],
      });
      mockProcessEmail.mockRejectedValue(new Error('Anthropic API down'));

      const result = await server.callTool('sq_process_email', { messageId: 'gm-1' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Anthropic API down');
    });
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/mcp-server/__tests__/gmail-tools.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

Add to `registerGmailTools` in `gmail.ts`:

```typescript
import { processEmail } from '../../services/email-processor.js';

  // ── sq_process_email ───────────────────────────────────────────────────────
  server.registerTool('sq_process_email', {
    description:
      'Process a Gmail message through the full task extraction pipeline: parse forwarded sender, store in DB, download attachments, extract tasks via Claude, create task records. Returns the tasks created.',
    inputSchema: {
      messageId: z.string().describe('Gmail message ID to process'),
    },
  }, async ({ messageId }) => {
    try {
      const message = await fetchMessage(messageId);
      if (!message) {
        return {
          content: [{ type: 'text' as const, text: `Error: Email with messageId "${messageId}" not found` }],
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
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/mcp-server/__tests__/gmail-tools.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/mcp-server/tools/gmail.ts src/mcp-server/__tests__/gmail-tools.test.ts
git commit -m "feat: add sq_process_email MCP tool"
```

---

### Task 5: Add `sq_download_attachment` tool

**Files:**
- Modify: `src/mcp-server/tools/gmail.ts`
- Modify: `src/mcp-server/__tests__/gmail-tools.test.ts`

**Step 1: Write the failing test**

Add to `gmail-tools.test.ts`:

```typescript
  // ── sq_download_attachment ────────────────────────────────────────────────

  describe('sq_download_attachment', () => {
    it('should download and return file path', async () => {
      mockDownloadAttachment.mockResolvedValue('/storage/uploads/1709500000-menu.pdf');

      const result = await server.callTool('sq_download_attachment', {
        messageId: 'gm-1',
        attachmentId: 'att-1',
        filename: 'menu.pdf',
      });

      expect(mockDownloadAttachment).toHaveBeenCalledWith('gm-1', 'att-1', 'menu.pdf');
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.filePath).toContain('menu.pdf');
    });

    it('should return error on download failure', async () => {
      mockDownloadAttachment.mockRejectedValue(new Error('No data in attachment'));

      const result = await server.callTool('sq_download_attachment', {
        messageId: 'gm-1',
        attachmentId: 'att-bad',
        filename: 'missing.pdf',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No data in attachment');
    });
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/mcp-server/__tests__/gmail-tools.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

Add to `registerGmailTools`:

```typescript
  // ── sq_download_attachment ─────────────────────────────────────────────────
  server.registerTool('sq_download_attachment', {
    description:
      'Download an email attachment to local storage. Returns the file path. Use attachment IDs from sq_read_email results.',
    inputSchema: {
      messageId: z.string().describe('Gmail message ID'),
      attachmentId: z.string().describe('Attachment ID (from sq_read_email)'),
      filename: z.string().describe('Filename to save as'),
    },
  }, async ({ messageId, attachmentId, filename }) => {
    try {
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
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/mcp-server/__tests__/gmail-tools.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/mcp-server/tools/gmail.ts src/mcp-server/__tests__/gmail-tools.test.ts
git commit -m "feat: add sq_download_attachment MCP tool"
```

---

### Task 6: Add `sq_list_processed_emails` tool

**Files:**
- Modify: `src/mcp-server/tools/gmail.ts`
- Modify: `src/mcp-server/__tests__/gmail-tools.test.ts`

**Step 1: Write the failing test**

Add to `gmail-tools.test.ts`:

```typescript
  // ── sq_list_processed_emails ──────────────────────────────────────────────

  describe('sq_list_processed_emails', () => {
    it('should list emails from database with defaults', async () => {
      mockListEmails.mockReturnValue([
        { id: 'em-1', gmailMessageId: 'gm-1', fromAddress: 'a@b.com', subject: 'Test', receivedAt: '2026-03-04', processedAt: '2026-03-04', createdAt: '2026-03-04' },
      ]);

      const result = await server.callTool('sq_list_processed_emails', {});
      expect(mockListEmails).toHaveBeenCalledWith({ limit: 20, status: 'all' });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.emails).toHaveLength(1);
    });

    it('should pass status filter', async () => {
      mockListEmails.mockReturnValue([]);

      await server.callTool('sq_list_processed_emails', { status: 'processed', limit: 5 });
      expect(mockListEmails).toHaveBeenCalledWith({ limit: 5, status: 'processed' });
    });

    it('should return error on DB failure', async () => {
      mockListEmails.mockImplementation(() => { throw new Error('DB locked'); });

      const result = await server.callTool('sq_list_processed_emails', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('DB locked');
    });
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/mcp-server/__tests__/gmail-tools.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

Add to `registerGmailTools`:

```typescript
import { listEmails } from '../../db/emails.js';

  // ── sq_list_processed_emails ───────────────────────────────────────────────
  server.registerTool('sq_list_processed_emails', {
    description:
      'List emails from the processing history database. Shows which emails have been processed and which are pending. Useful for checking if an email was already handled.',
    inputSchema: {
      limit: z.number().optional().describe('Max results (default: 20)'),
      status: z.enum(['processed', 'unprocessed', 'all']).optional().describe('Filter by processing status (default: all)'),
    },
  }, async ({ limit, status }) => {
    try {
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
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/mcp-server/__tests__/gmail-tools.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/mcp-server/tools/gmail.ts src/mcp-server/__tests__/gmail-tools.test.ts
git commit -m "feat: add sq_list_processed_emails MCP tool"
```

---

### Task 7: Add `sq_parse_pdf_menu` tool

**Files:**
- Modify: `src/mcp-server/tools/gmail.ts`
- Modify: `src/mcp-server/__tests__/gmail-tools.test.ts`

**Step 1: Write the failing test**

Add to `gmail-tools.test.ts`:

```typescript
  // ── sq_parse_pdf_menu ─────────────────────────────────────────────────────

  describe('sq_parse_pdf_menu', () => {
    it('should download PDF, extract text, and parse as menu', async () => {
      mockDownloadAttachment.mockResolvedValue('/storage/uploads/1709500000-menu.pdf');
      mockExtractPdfText.mockResolvedValue({
        text: 'Lunch\n========\nStarters\n-------\nSoup of the Day $8\nBread Basket $5',
        numPages: 1,
      });
      mockParseMenuText.mockReturnValue([
        { title: 'Lunch', description: null, sections: [
          { title: 'Starters', description: null, items: [
            { title: 'Soup of the Day', description: null, price: '$8' },
            { title: 'Bread Basket', description: null, price: '$5' },
          ]},
        ]},
      ]);

      const result = await server.callTool('sq_parse_pdf_menu', {
        messageId: 'gm-1',
        attachmentId: 'att-1',
        filename: 'menu.pdf',
      });

      expect(mockDownloadAttachment).toHaveBeenCalledWith('gm-1', 'att-1', 'menu.pdf');
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.parsed).toBe(true);
      expect(data.menus).toHaveLength(1);
      expect(data.menus[0].title).toBe('Lunch');
    });

    it('should return raw text when menu parsing yields empty', async () => {
      mockDownloadAttachment.mockResolvedValue('/storage/uploads/1709500000-doc.pdf');
      mockExtractPdfText.mockResolvedValue({
        text: 'This is just a regular document, not a menu.',
        numPages: 1,
      });
      mockParseMenuText.mockReturnValue([]);

      const result = await server.callTool('sq_parse_pdf_menu', {
        messageId: 'gm-1',
        attachmentId: 'att-2',
        filename: 'doc.pdf',
      });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.parsed).toBe(false);
      expect(data.rawText).toContain('regular document');
    });

    it('should return error on PDF extraction failure', async () => {
      mockDownloadAttachment.mockResolvedValue('/storage/uploads/scan.pdf');
      mockExtractPdfText.mockRejectedValue(new Error('No text could be extracted from the PDF'));

      const result = await server.callTool('sq_parse_pdf_menu', {
        messageId: 'gm-1',
        attachmentId: 'att-3',
        filename: 'scan.pdf',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No text could be extracted');
    });

    it('should return error on download failure', async () => {
      mockDownloadAttachment.mockRejectedValue(new Error('Attachment not found'));

      const result = await server.callTool('sq_parse_pdf_menu', {
        messageId: 'gm-1',
        attachmentId: 'att-bad',
        filename: 'missing.pdf',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Attachment not found');
    });
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/mcp-server/__tests__/gmail-tools.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

Add to `registerGmailTools`:

```typescript
import { readFileSync } from 'fs';
import { extractPdfText } from '../../services/pdf-extractor.js';
import { parseMenuText } from '../../services/menu-parser.js';

  // ── sq_parse_pdf_menu ──────────────────────────────────────────────────────
  server.registerTool('sq_parse_pdf_menu', {
    description:
      'Download a PDF attachment, extract text, and parse it into structured menu format (MenuTab[] JSON) ready for sq_update_menu. If the PDF text cannot be parsed as a menu, returns the raw text so you can format it manually.',
    inputSchema: {
      messageId: z.string().describe('Gmail message ID'),
      attachmentId: z.string().describe('Attachment ID (from sq_read_email)'),
      filename: z.string().describe('PDF filename'),
    },
  }, async ({ messageId, attachmentId, filename }) => {
    try {
      // 1. Download the PDF
      const filePath = await downloadAttachment(messageId, attachmentId, filename);

      // 2. Extract text from PDF
      const buffer = readFileSync(filePath);
      const { text, numPages } = await extractPdfText(buffer);

      // 3. Try to parse as menu
      const menus = parseMenuText(text);

      if (menus.length > 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ parsed: true, menus, numPages }, null, 2) }],
        };
      }

      // Menu parsing returned empty — return raw text for manual formatting
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ parsed: false, rawText: text, numPages }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/mcp-server/__tests__/gmail-tools.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/mcp-server/tools/gmail.ts src/mcp-server/__tests__/gmail-tools.test.ts
git commit -m "feat: add sq_parse_pdf_menu MCP tool"
```

---

### Task 8: Register Gmail tools in MCP server and update CLAUDE.md

**Files:**
- Modify: `src/mcp-server/index.ts`
- Modify: `CLAUDE.md`

**Step 1: Register the module**

Add import and registration to `src/mcp-server/index.ts`:

```typescript
// After line 24 (import { registerLinkTools })
import { registerGmailTools } from './tools/gmail.js';

// After line 89 (registerLinkTools(server))
registerGmailTools(server);
```

**Step 2: Update INSTRUCTIONS in index.ts**

Add to the INSTRUCTIONS string, after the "Content Editing Workflow" section:

```
## Email & PDF Menu Processing
1. Call sq_list_emails to check for new client emails.
2. Call sq_read_email to see full content and attachments.
3. For PDF menu attachments, use sq_parse_pdf_menu to extract structured MenuTab[] JSON.
4. If parsing succeeds, pass the menus directly to sq_update_menu.
5. If parsing fails (returns rawText), format the text yourself and use sq_update_menu.
6. Use sq_process_email to run the full task extraction pipeline on an email.
```

**Step 3: Update CLAUDE.md**

Add Gmail MCP tools to the MCP server section and key files table. Update tool count from ~48 to ~54.

**Step 4: Run full test suite**

Run: `npx vitest run --exclude '.claude/**' --exclude 'dist/**' --exclude 'src/archive/**'`
Expected: All tests pass including new gmail-tools tests.

**Step 5: Commit**

```bash
git add src/mcp-server/index.ts CLAUDE.md
git commit -m "feat: wire Gmail MCP tools into server and update docs"
```

---

### Task 9: Build MCP server and verify

**Step 1: Compile TypeScript**

Run: `npx tsc --noCheck`
Expected: Clean output (no errors due to --noCheck).

**Step 2: Verify compiled output exists**

Run: `ls dist/src/mcp-server/tools/gmail.js`
Expected: File exists.

**Step 3: Commit compiled output if needed**

Only if `dist/` is tracked (check `.gitignore`). Otherwise skip.
