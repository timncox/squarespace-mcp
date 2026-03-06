# Gmail MCP Tools — Design

## Purpose

Expose Gmail email reading and processing as MCP tools so both Claude Desktop and orchestrator agents can check emails, read content, download attachments, and process PDF menus.

## Tools (6)

### 1. `sq_list_emails`

List recent emails from the inbox.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | number | 10 | Max emails to return |
| `unreadOnly` | boolean | true | Only unread messages |

**Returns**: Array of `{ id, threadId, from, fromName, subject, date }`

**Wraps**: `fetchNewMessages()` from `src/services/gmail.ts`

### 2. `sq_read_email`

Read a specific email's full content.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `messageId` | string | yes | Gmail message ID |

**Returns**: `{ id, threadId, from, fromName, subject, date, bodyText, bodyHtml, attachments[] }` where attachments include `{ filename, mimeType, size, attachmentId }`.

**Wraps**: `fetchMessage()` from `src/services/gmail.ts`

### 3. `sq_process_email`

Trigger the full task extraction pipeline on an email — parse forwarded sender, store in DB, extract tasks via Claude, create task records.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `messageId` | string | yes | Gmail message ID |

**Returns**: Processing result with tasks created, site matched, and any errors.

**Wraps**: `processEmail()` from `src/services/email-processor.ts`

### 4. `sq_download_attachment`

Download an email attachment to local storage.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `messageId` | string | yes | Gmail message ID |
| `attachmentId` | string | yes | Attachment ID from `sq_read_email` |
| `filename` | string | yes | Filename to save as |

**Returns**: `{ filePath, mimeType, size }` — saved to `storage/uploads/`.

**Wraps**: `downloadAttachment()` from `src/services/gmail.ts`

### 5. `sq_list_processed_emails`

Query the SQLite `emails` table for previously processed emails.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | number | 20 | Max results |
| `status` | string | 'all' | Filter: 'processed', 'unprocessed', 'all' |

**Returns**: Array of email records with processing status.

**Wraps**: Existing `src/db/emails.ts` query functions (may need a new query for filtered listing).

### 6. `sq_parse_pdf_menu`

Download a PDF attachment, extract text, and parse it into structured menu format ready for `sq_update_menu`.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `messageId` | string | yes | Gmail message ID |
| `attachmentId` | string | yes | Attachment ID |
| `filename` | string | yes | PDF filename |

**Returns**: On success, `{ menus: MenuTab[], parsed: true }`. If text extraction succeeds but menu parsing fails (non-standard format), returns `{ rawText: string, parsed: false }` so the agent can format it manually.

**Pipeline**: `downloadAttachment()` → `extractPdfText()` → `parseMenuText()` → structured `MenuTab[]`

## Architecture

- **New file**: `src/mcp-server/tools/gmail.ts` — `registerGmailTools(server)`
- **Registration**: Added to `src/mcp-server/index.ts`
- **No new Gmail client code** — wraps existing `src/services/gmail.ts`, `src/services/email-processor.ts`, `src/services/pdf-extractor.ts`, `src/services/menu-parser.ts`
- **No siteId param** — Gmail tools are site-independent
- **No resolvePageIds** — not page-scoped
- **OAuth scope**: `gmail.readonly` already sufficient for all tools
- **Error pattern**: Same try/catch → `{ content, isError }` as all other MCP tools

## DB Changes

May need a filtered query function in `src/db/emails.ts` for `sq_list_processed_emails` (filter by processed_at IS NULL vs IS NOT NULL). Existing functions: `getUnprocessedEmails()`, `storeEmail()`, `getEmailByGmailId()`.

## Testing

- `src/mcp-server/__tests__/gmail.test.ts` — mock Gmail service + email processor, test all 6 tools
- Follow existing test pattern: `createMockServer()`, success + error per tool
- Test `sq_parse_pdf_menu` with both parseable and non-parseable PDF text

## Integration

- Claude Desktop: Tools appear automatically when MCP server loads
- Orchestrator agents: Available via `--allowedTools` glob (e.g., `sq_list_emails,sq_read_email`)
- Conversation flow: Agents can read email → see instructions + PDF menu → ask Tim questions via existing clarification flow → execute tasks
