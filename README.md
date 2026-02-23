# Squarespace Helper

AI agent that edits Squarespace websites based on forwarded client emails. Built for a web design agency workflow: clients email change requests, the agent extracts tasks, gets confirmation via WhatsApp (or a web dashboard), then executes edits using browser automation.

## How It Works

```
Client emails request → Tim forwards to Gmail → Agent extracts tasks
  → Tim confirms via WhatsApp/Dashboard → Browser agent edits Squarespace
  → Supervisor verifies → Tim gets screenshot of result
```

### Input Sources

- **Email**: Clients send change requests (add content, replace images, update menus). Tim forwards them to a monitored Gmail inbox. The agent parses the email, identifies tasks, and asks Tim to confirm.
- **WhatsApp**: Tim can send direct editing requests ("Add a new section to the homepage of clientsite.com with their spring menu"). The agent interprets the message and creates tasks.
- **Dashboard**: Web UI at `/dashboard` with a chat panel that works like WhatsApp but runs in the browser. Includes live task progress via SSE.

### Agent Pipeline

For complex content tasks, a multi-agent pipeline runs before editing:

1. **Research Agent** — Searches the web (via Brave API) or visits project URLs for context
2. **Site Analyst Agent** — Screenshots the target page, analyzes layout/style/brand tone
3. **Content Strategist Agent** — Drafts a detailed content plan with exact copy, placement, and editor instructions
4. **Browser Agent** — Executes the plan on Squarespace using Playwright
5. **Supervisor Agent** — Verifies the result by comparing before/after screenshots, retries on failure
6. **Learning Agent** — Extracts reusable patterns from execution (selectors that worked, timing, Squarespace UI quirks)

### Conversation State Machine

Tim interacts with the agent through a confirmation flow:

```
idle → awaiting_confirm → executing → completed
                        → rejected
                        → clarifying → awaiting_confirm
                        → planning → awaiting_plan_approval → executing
                                                             → revising
                                                             → rejected
```

## Setup

### Prerequisites

- Node.js 18+
- A Squarespace account with sites to manage
- Anthropic API key (Claude)
- WhatsApp Business API credentials (optional — can use dashboard only)
- Gmail API OAuth credentials
- Brave Search API key (for research agent)

### Installation

```bash
npm install
npx playwright install chromium
```

### Configuration

Create a `.env` file:

```env
ANTHROPIC_API_KEY=sk-ant-...
WHATSAPP_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_VERIFY_TOKEN=...
TIM_PHONE_NUMBER=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/callback
BRAVE_API_KEY=...
SQUARESPACE_EMAIL=...
SQUARESPACE_PASSWORD=...
PORT=3000
```

### Gmail Setup

```bash
npm run setup-gmail
```

This runs an OAuth flow to get Gmail API tokens. Tokens are stored in `storage/auth/`.

### Running

```bash
# Development (auto-reload)
npm run dev

# Production
npm run build && npm start

# With ngrok tunnel (for WhatsApp webhooks)
npm run start:all
```

The server starts on port 3000:
- `http://localhost:3000/health` — Health check
- `http://localhost:3000/dashboard` — Web dashboard
- `http://localhost:3000/webhook` — WhatsApp webhook

## Architecture

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js + TypeScript (ES modules) |
| Server | Fastify |
| AI | Claude API (Sonnet for reasoning, Haiku for fast tasks) |
| Browser | Playwright (Chromium) |
| Database | SQLite via better-sqlite3 |
| Logging | Pino |
| APIs | WhatsApp Cloud API, Gmail API, Brave Search API |

### Directory Structure

```
src/
  index.ts                    # Entry point: server + email polling
  server.ts                   # Fastify setup + route registration
  cli.ts                      # CLI tool for manual operations

  agents/                     # Multi-agent content pipeline
    coordinator.ts            # Pipeline orchestrator
    research-agent.ts         # Web search for context
    url-researcher.ts         # Visit project URLs directly
    site-analyst-agent.ts     # Screenshot + analyze page
    content-strategist-agent.ts  # Draft content plan
    supervisor-agent.ts       # Verify execution results
    learning-agent.ts         # Extract reusable patterns
    types.ts                  # Shared types (ContentPlan, etc.)

  automation/                 # Browser agent (Squarespace editing)
    browser-agent.ts          # Core loop: screenshot → Claude → action → repeat
    browser-agent-actions.ts  # All Playwright actions (click, fill, upload, etc.)
    browser-agent-prompt.ts   # System prompt + step messages
    browser-agent-state.ts    # DOM state extraction
    browser-agent-rescue.ts   # Stuck detection + rescue hints
    browser-manager.ts        # Playwright browser lifecycle
    editor-actions.ts         # Save/publish helpers
    selectors.ts              # Common CSS selectors
    site-discovery.ts         # Auto-detect site pages/structure
    site-navigator.ts         # Navigate to sites/pages in Squarespace
    squarespace-auth.ts       # Login to Squarespace
    squarespace-docs.ts       # Squarespace help doc lookup (for rescue)
    actions/                  # Specialized action modules
    __tests__/                # Unit + integration tests

  config/
    models.ts                 # Claude model IDs

  db/                         # SQLite database layer
    database.ts               # Schema, migrations, connection
    tasks.ts                  # Task CRUD
    conversations.ts          # Conversation CRUD
    whatsapp-messages.ts      # Message storage
    emails.ts                 # Email storage
    learnings.ts              # Learned patterns storage
    audit-log.ts              # Action audit trail

  models/                     # TypeScript interfaces
    task.ts                   # Task, TaskType, TaskStatus
    conversation.ts           # Conversation, ConversationStatus
    site-config.ts            # Site configuration

  routes/                     # HTTP endpoints
    dashboard.ts              # Dashboard UI + SSE + chat
    whatsapp-webhook.ts       # WhatsApp message webhook
    screenshots.ts            # Serve screenshot images
    health.ts                 # Health check

  services/                   # Business logic
    whatsapp.ts               # WhatsApp API + dashboard SSE bridge
    gmail.ts                  # Gmail API client
    email-parser.ts           # Email parsing (forwarded emails, attachments)
    email-processor.ts        # Email → tasks pipeline
    task-extractor.ts         # Claude-powered task extraction from email text
    file-manager.ts           # Attachment storage + resolution
    conversation-handler.ts   # Message routing
    dashboard-events.ts       # SSE event bus
    brave-search.ts           # Brave Search API
    transcription.ts          # Audio message transcription
    whatsapp-request-interpreter.ts  # WhatsApp message → task interpretation
    conversation/             # Conversation sub-modules
      message-handlers.ts     # Handle confirm, clarify, plan approval
      execution.ts            # Task execution (single, batched, multi-site)
      planning.ts             # Content pipeline trigger
      helpers.ts              # Formatting + diagnostics

  utils/
    logger.ts                 # Pino logger
    screenshot.ts             # Screenshot capture + storage
    errors.ts                 # errMsg() utility
    retry.ts                  # Retry with backoff
    anthropic-client.ts       # Anthropic SDK client singleton

scripts/                      # Dev/debug scripts
storage/                      # Runtime data (not committed)
  uploads/                    # Email attachments + WhatsApp media
  screenshots/                # Browser agent screenshots
  auth/                       # Gmail OAuth tokens
  *.db                        # SQLite databases
```

## Browser Agent

The browser agent is the core execution engine. It operates in a loop:

1. Take a screenshot of the current page
2. Extract DOM state (visible text, buttons, panels, editing mode)
3. Send screenshot + state + task description to Claude
4. Claude responds with a single JSON action
5. Execute the action via Playwright
6. Repeat until `done` or max steps reached

### Available Actions

| Action | Description |
|--------|-------------|
| `click` | Click an element by CSS selector |
| `dblclick` | Double-click an element |
| `fill` | Type text into an input/textarea |
| `navigate` | Go to a URL |
| `scroll` | Scroll the page |
| `pressKey` | Press keyboard key(s) |
| `uploadFile` | Upload a file via `<input type="file">` |
| `replaceImage` | Replace an existing image block (7-step compound action) |
| `addImageBlock` | Add a new image block with upload (7-step compound action) |
| `enterSectionEditMode` | Enter Squarespace section editing |
| `exitFooter` | Escape footer editing mode |
| `addSection` | Add a new page section |
| `createPage` | Create a new page |
| `done` | Task complete |
| `error` | Task failed |

### Stuck Detection

The agent has two layers of stuck detection:

1. **Screenshot-based** (hard stuck): If 8 consecutive screenshots are identical, the agent gives up (tries dynamic doc lookup first)
2. **Action-based** (soft stuck): Detects repetitive action patterns and injects rescue hints with Squarespace-specific advice

### Image Upload Flow

Image uploads use Playwright's `setInputFiles()` API. Three actions support this:

**`uploadFile`** — Generic file upload to any `<input type="file">`

**`replaceImage`** — Replace an existing image:
1. Find image by alt text, filename, or nearby text
2. Click through overlay to select section
3. Enter section edit mode
4. Double-click image to open editor
5. Find `<input type="file">` and upload (tries multiple strategies)
6. Set alt text if provided
7. Close panel

**`addImageBlock`** — Add a new image block:
1. Verify section is in edit mode
2. Click ADD BLOCK
3. Search for "Image" block type
4. Wait for image editor panel
5. Upload via `<input type="file">`
6. Set alt text if provided
7. Close panel

Files come from: email attachments (downloaded to `storage/uploads/`) or WhatsApp media.

## Dashboard

Web UI at `/dashboard` with four tabs:

- **Tasks** — View all tasks, filter by status, retry failed tasks
- **Clients** — Client/site configuration
- **Learnings** — Learned patterns from past executions
- **Chat** — Interactive chat panel (works like WhatsApp but in-browser)

The chat panel uses Server-Sent Events (SSE) for live updates. Messages, buttons, images, task progress, and conversation state changes all stream in real-time.

## Task Types

| Type | Description |
|------|-------------|
| `add_content` | Add new text, sections, or blocks to a page |
| `remove_content` | Remove specific content from a page |
| `upload_file_and_link` | Upload a PDF/image and create a link to it |
| `replace_file` | Replace an existing uploaded file |
| `update_menu_block` | Update menu items/prices |
| `general_edit` | Open-ended editing request |

## Testing

```bash
npm test              # Run all tests
npm run test:unit     # Parse action tests only
npm run test:integration  # Compound action integration tests
```

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/test-login.ts` | Test Squarespace login flow |
| `scripts/explore-editor.ts` | Interactive Squarespace editor exploration |
| `scripts/intercept-upload.ts` | Network intercept to discover Squarespace upload API |
| `scripts/test-discovery.ts` | Test site page discovery |
| `scripts/send-plan.ts` | Send a test content plan |
| `scripts/test-whatsapp.ts` | Test WhatsApp API |
| `scripts/test-task-extraction.ts` | Test task extraction from email text |
