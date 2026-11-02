# Squarespace MMP Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an MMP bot (`@squarespace`) that bridges Squarespace MCP tools to MMP messaging, with multi-user Browserbase auth, curated commands, and session/site monitoring.

**Architecture:** Express server on Railway. MMP webhook handler receives DMs, routes to command handlers. Squarespace MCP spawned as stdio subprocess per-user with isolated session dirs. Browserbase SDK for cloud login. SQLite for user state. Cron for monitoring.

**Tech Stack:** TypeScript, Express, better-sqlite3, node-cron, @browserbasehq/sdk, playwright-core, child_process (for stdio MCP subprocess)

**Spec:** `docs/superpowers/specs/2026-03-31-squarespace-mmp-bot-design.md`

**Project location:** `/Users/timcox/tim-os/squarespace-mmp-bot/`

---

## File Structure

```
squarespace-mmp-bot/
├── src/
│   ├── server.ts          — Express app, webhook handler, command router
│   ├── mmp-client.ts      — HTTP MCP client for MMP (send messages, manage inbox)
│   ├── sqsp-client.ts     — Stdio subprocess manager for Squarespace MCP
│   ├── auth.ts            — Browserbase login flow for new users
│   ├── commands.ts        — Command parser + handler functions
│   ├── monitor.ts         — Cron jobs: session health + site change detection
│   └── db.ts              — SQLite schema, queries, migrations
├── package.json
├── tsconfig.json
├── Dockerfile
├── .gitignore
└── README.md
```

---

### Task 1: Scaffold project

**Files:**
- Create: `squarespace-mmp-bot/package.json`
- Create: `squarespace-mmp-bot/tsconfig.json`
- Create: `squarespace-mmp-bot/.gitignore`

- [ ] **Step 1: Create project directory**

```bash
mkdir -p /Users/timcox/tim-os/squarespace-mmp-bot/src
cd /Users/timcox/tim-os/squarespace-mmp-bot
```

- [ ] **Step 2: Create package.json**

```json
{
  "name": "squarespace-mmp-bot",
  "version": "1.0.0",
  "type": "module",
  "description": "MMP bot for managing Squarespace sites via messaging",
  "main": "dist/server.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/server.js",
    "dev": "npx tsx src/server.ts"
  },
  "dependencies": {
    "@browserbasehq/sdk": "^2.0.0",
    "better-sqlite3": "^12.8.0",
    "express": "^5.2.1",
    "node-cron": "^3.0.3",
    "playwright-core": "^1.58.2"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12",
    "@types/express": "^5.0.6",
    "@types/node": "^22.0.0",
    "@types/node-cron": "^3.0.11",
    "tsx": "^4.21.0",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Create .gitignore**

```
node_modules/
dist/
data/
storage/
.env
```

- [ ] **Step 5: Install dependencies**

```bash
cd /Users/timcox/tim-os/squarespace-mmp-bot && npm install
```

- [ ] **Step 6: Initialize git repo and commit**

```bash
cd /Users/timcox/tim-os/squarespace-mmp-bot
git init
git add package.json tsconfig.json .gitignore
git commit -m "chore: scaffold squarespace-mmp-bot project"
```

---

### Task 2: Database layer

**Files:**
- Create: `squarespace-mmp-bot/src/db.ts`

- [ ] **Step 1: Write db.ts**

```typescript
import Database from "better-sqlite3";
import path from "node:path";
import { mkdirSync } from "node:fs";

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "sqsp-bot.db");

let db: Database.Database;

export function getDb(): Database.Database {
  if (db) return db;

  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      mmp_handle TEXT PRIMARY KEY,
      mmp_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_active TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      mmp_handle TEXT PRIMARY KEY REFERENCES users(mmp_handle),
      session_dir TEXT NOT NULL,
      last_health_check TEXT,
      is_healthy INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS site_snapshots (
      mmp_handle TEXT NOT NULL,
      site_id TEXT NOT NULL,
      page_slug TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      snapshot_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (mmp_handle, site_id, page_slug)
    );

    CREATE TABLE IF NOT EXISTS alert_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mmp_handle TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      message TEXT NOT NULL,
      sent_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pending_confirmations (
      mmp_handle TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      args TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  return db;
}

// --- Users ---

export interface User {
  mmp_handle: string;
  mmp_user_id: string;
  created_at: string;
  last_active: string;
}

export function upsertUser(handle: string, userId: string): void {
  getDb().prepare(`
    INSERT INTO users (mmp_handle, mmp_user_id, created_at, last_active)
    VALUES (?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(mmp_handle) DO UPDATE SET
      mmp_user_id = excluded.mmp_user_id,
      last_active = datetime('now')
  `).run(handle, userId);
}

export function getUser(handle: string): User | null {
  return getDb().prepare("SELECT * FROM users WHERE mmp_handle = ?").get(handle) as User | null;
}

export function getAllUsers(): User[] {
  return getDb().prepare("SELECT * FROM users").all() as User[];
}

// --- Sessions ---

export interface Session {
  mmp_handle: string;
  session_dir: string;
  last_health_check: string | null;
  is_healthy: number;
}

export function upsertSession(handle: string, sessionDir: string): void {
  getDb().prepare(`
    INSERT INTO sessions (mmp_handle, session_dir, is_healthy)
    VALUES (?, ?, 1)
    ON CONFLICT(mmp_handle) DO UPDATE SET
      session_dir = excluded.session_dir,
      is_healthy = 1
  `).run(handle, sessionDir);
}

export function getSession(handle: string): Session | null {
  return getDb().prepare("SELECT * FROM sessions WHERE mmp_handle = ?").get(handle) as Session | null;
}

export function getAllSessions(): Session[] {
  return getDb().prepare("SELECT * FROM sessions").all() as Session[];
}

export function updateSessionHealth(handle: string, isHealthy: boolean): void {
  getDb().prepare(`
    UPDATE sessions SET is_healthy = ?, last_health_check = datetime('now')
    WHERE mmp_handle = ?
  `).run(isHealthy ? 1 : 0, handle);
}

export function deleteSession(handle: string): void {
  getDb().prepare("DELETE FROM sessions WHERE mmp_handle = ?").run(handle);
}

// --- Site Snapshots ---

export function upsertSnapshot(handle: string, siteId: string, pageSlug: string, contentHash: string): boolean {
  const existing = getDb().prepare(
    "SELECT content_hash FROM site_snapshots WHERE mmp_handle = ? AND site_id = ? AND page_slug = ?",
  ).get(handle, siteId, pageSlug) as { content_hash: string } | undefined;

  getDb().prepare(`
    INSERT INTO site_snapshots (mmp_handle, site_id, page_slug, content_hash, snapshot_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(mmp_handle, site_id, page_slug) DO UPDATE SET
      content_hash = excluded.content_hash,
      snapshot_at = datetime('now')
  `).run(handle, siteId, pageSlug, contentHash);

  // Return true if content changed
  return existing !== undefined && existing.content_hash !== contentHash;
}

export function getUserSnapshots(handle: string): Array<{ site_id: string; page_slug: string; content_hash: string }> {
  return getDb().prepare(
    "SELECT site_id, page_slug, content_hash FROM site_snapshots WHERE mmp_handle = ?",
  ).all(handle) as Array<{ site_id: string; page_slug: string; content_hash: string }>;
}

// --- Alert Log ---

export function logAlert(handle: string, alertType: string, message: string): void {
  getDb().prepare(`
    INSERT INTO alert_log (mmp_handle, alert_type, message, sent_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(handle, alertType, message);
}

export function recentAlertExists(handle: string, alertType: string, withinHours: number): boolean {
  const row = getDb().prepare(`
    SELECT 1 FROM alert_log
    WHERE mmp_handle = ? AND alert_type = ?
      AND sent_at > datetime('now', ? || ' hours')
    LIMIT 1
  `).get(handle, alertType, `-${withinHours}`);
  return row !== undefined;
}

// --- Pending Confirmations ---

export function setPendingConfirmation(handle: string, action: string, args: Record<string, unknown>): void {
  getDb().prepare(`
    INSERT INTO pending_confirmations (mmp_handle, action, args, created_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(mmp_handle) DO UPDATE SET
      action = excluded.action,
      args = excluded.args,
      created_at = datetime('now')
  `).run(handle, action, JSON.stringify(args));
}

export function getPendingConfirmation(handle: string): { action: string; args: Record<string, unknown> } | null {
  const row = getDb().prepare(
    "SELECT action, args FROM pending_confirmations WHERE mmp_handle = ?",
  ).get(handle) as { action: string; args: string } | null;
  if (!row) return null;
  return { action: row.action, args: JSON.parse(row.args) };
}

export function clearPendingConfirmation(handle: string): void {
  getDb().prepare("DELETE FROM pending_confirmations WHERE mmp_handle = ?").run(handle);
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd /Users/timcox/tim-os/squarespace-mmp-bot && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/db.ts
git commit -m "feat: add SQLite database layer with users, sessions, snapshots, alerts"
```

---

### Task 3: MMP client

**Files:**
- Create: `squarespace-mmp-bot/src/mmp-client.ts`

- [ ] **Step 1: Write mmp-client.ts**

Reused pattern from ticket-fighter-bot:

```typescript
/**
 * Lightweight HTTP MCP client for calling tools on MMP.
 * Reused pattern from nyc-civic-bot / ticket-fighter-bot.
 */

const TIMEOUT = 30_000;

interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export class McpClient {
  private baseUrl: string;
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private async request(method: string, params?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }

    const res = await fetch(this.baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method,
        params: params ?? {},
        id: this.nextId++,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    if (!res.ok) {
      throw new Error(`MCP ${res.status}: ${await res.text()}`);
    }

    const contentType = res.headers.get("content-type") || "";
    let data: any;

    if (contentType.includes("text/event-stream")) {
      const text = await res.text();
      for (const line of text.split("\n")) {
        if (line.startsWith("data: ")) {
          data = JSON.parse(line.slice(6));
          break;
        }
      }
      if (!data) throw new Error("No data in SSE response");
    } else {
      data = (await res.json()) as any;
    }

    if (data.error) {
      throw new Error(`MCP error: ${data.error.message}`);
    }
    return data.result;
  }

  async connect(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "squarespace-mmp-bot", version: "1.0.0" },
    });
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    if (!this.sessionId) await this.connect();
    return (await this.request("tools/call", { name, arguments: args })) as McpToolResult;
  }

  async call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.callTool(name, args);
    if (result.isError) {
      throw new Error(result.content?.[0]?.text ?? "Tool error");
    }
    const text = result.content?.[0]?.text ?? "{}";
    return JSON.parse(text) as T;
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd /Users/timcox/tim-os/squarespace-mmp-bot && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/mmp-client.ts
git commit -m "feat: add MMP HTTP MCP client"
```

---

### Task 4: Squarespace MCP subprocess client

**Files:**
- Create: `squarespace-mmp-bot/src/sqsp-client.ts`

- [ ] **Step 1: Write sqsp-client.ts**

This spawns the Squarespace MCP server as a stdio subprocess per-user, sends JSON-RPC over stdin/stdout:

```typescript
/**
 * Squarespace MCP subprocess client.
 * Spawns the Squarespace MCP server as a stdio child process per-user,
 * sends JSON-RPC 2.0 over stdin, reads responses from stdout.
 */

import { spawn, ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const SQSP_MCP_PATH = process.env.SQSP_MCP_PATH || "/app/sqsp-mcp/dist/src/mcp-server/index.js";
const STORAGE_ROOT = process.env.STORAGE_ROOT || path.join(process.cwd(), "storage", "users");
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: any;
  error?: { code: number; message: string };
}

interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

interface PendingRequest {
  resolve: (value: JsonRpcResponse) => void;
  reject: (reason: Error) => void;
}

export class SqspClient {
  private handle: string;
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = "";
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private initialized = false;

  constructor(handle: string) {
    this.handle = handle;
  }

  /** Get the session directory for this user. */
  get sessionDir(): string {
    return path.join(STORAGE_ROOT, this.handle, "auth");
  }

  /** Get the full storage directory for this user. */
  get userDir(): string {
    return path.join(STORAGE_ROOT, this.handle);
  }

  /** Ensure user storage directories exist. */
  ensureDirs(): void {
    mkdirSync(this.sessionDir, { recursive: true });
    mkdirSync(path.join(this.userDir, "data"), { recursive: true });
  }

  /** Spawn the Squarespace MCP subprocess if not already running. */
  private async ensureProcess(): Promise<void> {
    if (this.proc && !this.proc.killed) {
      this.resetIdleTimer();
      return;
    }

    this.ensureDirs();

    this.proc = spawn("node", [SQSP_MCP_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        SESSION_DIR: this.sessionDir,
        SITES_CONFIG: path.join(this.userDir, "sites.json"),
        DB_PATH: path.join(this.userDir, "data", "sqhelper.db"),
      },
    });

    this.buffer = "";
    this.initialized = false;

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      // Squarespace MCP logs to stderr (pino) — ignore in production
      const msg = chunk.toString().trim();
      if (msg) console.error(`[sqsp:${this.handle}] ${msg.slice(0, 200)}`);
    });

    this.proc.on("exit", (code) => {
      console.error(`[sqsp:${this.handle}] Process exited with code ${code}`);
      this.proc = null;
      this.initialized = false;
      // Reject all pending requests
      for (const [id, req] of this.pending) {
        req.reject(new Error(`Subprocess exited with code ${code}`));
        this.pending.delete(id);
      }
    });

    // Initialize the MCP session
    await this.sendRequest("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "squarespace-mmp-bot", version: "1.0.0" },
    });
    this.initialized = true;

    this.resetIdleTimer();
  }

  /** Process buffered stdout data, extracting complete JSON-RPC responses. */
  private processBuffer(): void {
    // JSON-RPC over stdio: one JSON object per line
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop()!; // keep incomplete line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse;
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const req = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          req.resolve(msg);
        }
      } catch {
        // Not valid JSON — likely a log line, ignore
      }
    }
  }

  /** Send a JSON-RPC request and wait for the response. */
  private sendRequest(method: string, params: unknown): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.killed) {
        reject(new Error("Subprocess not running"));
        return;
      }

      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });

      const msg = JSON.stringify({ jsonrpc: "2.0", method, params, id }) + "\n";
      this.proc.stdin!.write(msg, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });

      // Timeout after 60 seconds
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request ${method} timed out`));
        }
      }, 60_000);
    });
  }

  /** Reset the idle timer — kills subprocess after IDLE_TIMEOUT_MS of inactivity. */
  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.kill(), IDLE_TIMEOUT_MS);
  }

  /** Call a Squarespace MCP tool. */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    await this.ensureProcess();
    const response = await this.sendRequest("tools/call", { name, arguments: args });
    if (response.error) {
      throw new Error(`MCP error: ${response.error.message}`);
    }
    return response.result as McpToolResult;
  }

  /** Call a tool and parse the JSON text result. */
  async call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.callTool(name, args);
    if (result.isError) {
      throw new Error(result.content?.[0]?.text ?? "Tool error");
    }
    const text = result.content?.[0]?.text ?? "{}";
    return JSON.parse(text) as T;
  }

  /** Kill the subprocess. */
  kill(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
    this.initialized = false;
  }

  /** Check if this client has an active subprocess. */
  get isRunning(): boolean {
    return this.proc !== null && !this.proc.killed;
  }
}

// --- Pool of per-user clients ---

const clientPool = new Map<string, SqspClient>();

export function getSqspClient(handle: string): SqspClient {
  let client = clientPool.get(handle);
  if (!client) {
    client = new SqspClient(handle);
    clientPool.set(handle, client);
  }
  return client;
}

export function killAllClients(): void {
  for (const client of clientPool.values()) {
    client.kill();
  }
  clientPool.clear();
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd /Users/timcox/tim-os/squarespace-mmp-bot && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/sqsp-client.ts
git commit -m "feat: add Squarespace MCP stdio subprocess client with pooling"
```

---

### Task 5: Browserbase auth flow

**Files:**
- Create: `squarespace-mmp-bot/src/auth.ts`

- [ ] **Step 1: Write auth.ts**

```typescript
/**
 * Browserbase cloud login flow for Squarespace authentication.
 * Creates a cloud browser session, user logs in via live URL,
 * captures cookies over CDP and saves per-user.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const BROWSERBASE_API_KEY = process.env.BROWSERBASE_API_KEY || "";
const BROWSERBASE_PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID || "";
const STORAGE_ROOT = process.env.STORAGE_ROOT || path.join(process.cwd(), "storage", "users");
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const POLL_INTERVAL_MS = 2_000;

export interface LoginResult {
  status: "success" | "timeout" | "error";
  liveUrl?: string;
  cookieCount?: number;
  message: string;
}

/**
 * Start a Browserbase cloud login session for a user.
 * Returns a live URL for the user to open, then polls for cookies.
 *
 * @param handle MMP handle (used for storage path)
 * @param onLiveUrl Callback called immediately with the live URL so the bot can send it to the user
 */
export async function startCloudLogin(
  handle: string,
  onLiveUrl: (url: string) => void,
): Promise<LoginResult> {
  if (!BROWSERBASE_API_KEY) {
    return {
      status: "error",
      message: "BROWSERBASE_API_KEY not configured. Cloud login unavailable.",
    };
  }

  let browser: any = null;

  try {
    // Dynamic imports
    const { default: Browserbase } = await import("@browserbasehq/sdk");
    const { chromium } = await import("playwright-core");

    // 1. Create Browserbase session
    const bb = new Browserbase({ apiKey: BROWSERBASE_API_KEY });
    const sessionOpts: Record<string, unknown> = {};
    if (BROWSERBASE_PROJECT_ID) {
      sessionOpts.projectId = BROWSERBASE_PROJECT_ID;
    }
    const session = await bb.sessions.create(sessionOpts);

    // 2. Connect Playwright over CDP
    browser = await chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? await context.newPage();

    // 3. Navigate to Squarespace login
    await page.goto("https://login.squarespace.com", { waitUntil: "domcontentloaded" });

    // 4. Send live URL to user immediately
    const liveUrl = `https://www.browserbase.com/sessions/${session.id}/debug`;
    onLiveUrl(liveUrl);

    // 5. Poll for member-session cookie
    const startTime = Date.now();

    while (Date.now() - startTime < LOGIN_TIMEOUT_MS) {
      const cookies = await context.cookies();
      const hasMemberSession = cookies.some(
        (c: { name: string }) => c.name === "member-session",
      );

      if (hasMemberSession) {
        const fullState = await context.storageState();

        // Save to user's session directory
        const sessionDir = path.join(STORAGE_ROOT, handle, "auth");
        mkdirSync(sessionDir, { recursive: true });
        writeFileSync(
          path.join(sessionDir, "sqsp-session.json"),
          JSON.stringify(fullState, null, 2),
          "utf-8",
        );

        return {
          status: "success",
          liveUrl,
          cookieCount: fullState.cookies.length,
          message: `Login successful! Saved ${fullState.cookies.length} cookies.`,
        };
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    return {
      status: "timeout",
      liveUrl,
      message: "Login timed out after 5 minutes. Send `login` to try again.",
    };
  } catch (err) {
    return {
      status: "error",
      message: `Login error: ${(err as Error).message}`,
    };
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* cleanup */ }
    }
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd /Users/timcox/tim-os/squarespace-mmp-bot && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/auth.ts
git commit -m "feat: add Browserbase cloud login flow for per-user Squarespace auth"
```

---

### Task 6: Command parser and handlers

**Files:**
- Create: `squarespace-mmp-bot/src/commands.ts`

- [ ] **Step 1: Write commands.ts**

```typescript
/**
 * Command parser and handlers for Squarespace bot.
 * Matches natural language DMs to curated commands.
 */

import { getSqspClient } from "./sqsp-client.js";
import { getSession, setPendingConfirmation, getPendingConfirmation, clearPendingConfirmation } from "./db.js";

type SendFn = (body: string) => Promise<void>;

// --- Command matching ---

interface CommandMatch {
  command: string;
  args: string[];
}

const PATTERNS: Array<{ re: RegExp; command: string; argCount: number }> = [
  // Account
  { re: /^(login|connect|authenticate)\b/i, command: "login", argCount: 0 },
  { re: /^(logout|disconnect)\b/i, command: "logout", argCount: 0 },
  { re: /^(help|commands|what can you do)\b/i, command: "help", argCount: 0 },

  // Info
  { re: /^(list sites|my sites|sites)\b/i, command: "list_sites", argCount: 0 },
  { re: /^(status|health|session)\b/i, command: "status", argCount: 0 },
  { re: /^list pages?\s+(.+)/i, command: "list_pages", argCount: 1 },
  { re: /^(?:read|show|get) page\s+(\S+)\s+(\S+)/i, command: "read_page", argCount: 2 },

  // Content
  { re: /^update text\s+(\S+)\s+(\S+)\s+(\S+)\s+([\s\S]+)/i, command: "update_text", argCount: 4 },
  { re: /^update announcement\s+(\S+)\s+([\s\S]+)/i, command: "update_announcement", argCount: 2 },
  { re: /^add blog post\s+(\S+)\s+"([^"]+)"\s+([\s\S]+)/i, command: "add_blog_post", argCount: 3 },
  { re: /^upload image\s+(\S+)\s+(\S+)/i, command: "upload_image", argCount: 2 },
  { re: /^update menu\s+(\S+)\s+(\S+)\s+([\s\S]+)/i, command: "update_menu", argCount: 3 },
  { re: /^get css\s+(\S+)/i, command: "get_css", argCount: 1 },
  { re: /^update css\s+(\S+)\s+([\s\S]+)/i, command: "update_css", argCount: 2 },

  // Structure
  { re: /^add page\s+(\S+)\s+"?([^"]+)"?$/i, command: "add_page", argCount: 2 },
  { re: /^delete page\s+(\S+)\s+(\S+)/i, command: "delete_page", argCount: 2 },

  // Confirmation
  { re: /^(yes|confirm|y)\b/i, command: "confirm_yes", argCount: 0 },
  { re: /^(no|cancel|n)\b/i, command: "confirm_no", argCount: 0 },
];

export function parseCommand(text: string): CommandMatch | null {
  const trimmed = text.trim();
  for (const { re, command, argCount } of PATTERNS) {
    const match = trimmed.match(re);
    if (match) {
      const args = match.slice(1, argCount + 1).map((a) => a?.trim()).filter(Boolean);
      return { command, args };
    }
  }
  return null;
}

// --- Require session helper ---

function requireSession(handle: string, send: SendFn): boolean {
  const session = getSession(handle);
  if (!session) {
    send("You haven't connected a Squarespace account yet. Send `login` to get started.");
    return false;
  }
  return true;
}

// --- Command handlers ---

export async function handleCommand(
  handle: string,
  text: string,
  send: SendFn,
  startLogin: () => Promise<void>,
): Promise<void> {
  const parsed = parseCommand(text);

  if (!parsed) {
    await send("I'm not sure what you mean. Send `help` to see what I can do.");
    return;
  }

  const { command, args } = parsed;

  // Handle confirmations first
  if (command === "confirm_yes" || command === "confirm_no") {
    await handleConfirmation(handle, command === "confirm_yes", send);
    return;
  }

  // Account commands (no session required)
  if (command === "login") {
    await startLogin();
    return;
  }

  if (command === "logout") {
    await handleLogout(handle, send);
    return;
  }

  if (command === "help") {
    await handleHelp(send);
    return;
  }

  // All other commands require a session
  if (!requireSession(handle, send)) return;

  const client = getSqspClient(handle);

  try {
    switch (command) {
      case "list_sites":
        await handleListSites(client, send);
        break;
      case "status":
        await handleStatus(client, send);
        break;
      case "list_pages":
        await handleListPages(client, args[0], send);
        break;
      case "read_page":
        await handleReadPage(client, args[0], args[1], send);
        break;
      case "update_text":
        await handleUpdateText(client, args[0], args[1], args[2], args[3], send);
        break;
      case "update_announcement":
        await handleUpdateAnnouncement(client, args[0], args[1], send);
        break;
      case "add_blog_post":
        await handleAddBlogPost(client, args[0], args[1], args[2], send);
        break;
      case "upload_image":
        await handleUploadImage(client, args[0], args[1], send);
        break;
      case "update_menu":
        await handleUpdateMenu(client, args[0], args[1], args[2], send);
        break;
      case "get_css":
        await handleGetCss(client, args[0], send);
        break;
      case "update_css":
        await handleUpdateCss(client, args[0], args[1], send);
        break;
      case "add_page":
        await handleAddPage(client, args[0], args[1], send);
        break;
      case "delete_page":
        await handleDeletePage(handle, client, args[0], args[1], send);
        break;
      default:
        await send("I'm not sure what you mean. Send `help` to see what I can do.");
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("401") || msg.includes("Unauthorized") || msg.includes("session")) {
      await send("Session expired. Send `login` to reconnect.");
    } else {
      await send(`Error: ${msg.slice(0, 300)}`);
    }
  }
}

// --- Individual handlers ---

async function handleHelp(send: SendFn): Promise<void> {
  await send(
    `Squarespace Bot Commands:\n\n` +
    `**Account:**\n` +
    `- login — Connect your Squarespace account\n` +
    `- logout — Disconnect account\n` +
    `- status — Session health for all sites\n\n` +
    `**Info:**\n` +
    `- list sites — Show all your sites\n` +
    `- list pages <site> — Pages on a site\n` +
    `- read page <site> <page> — Read page content\n\n` +
    `**Content:**\n` +
    `- update text <site> <page> <block> <text> — Update text block\n` +
    `- update announcement <site> <text> — Set announcement bar\n` +
    `- add blog post <site> "Title" Body text — Create blog post\n` +
    `- upload image <site> <url> — Upload image from URL\n` +
    `- update menu <site> <page> <content> — Update menu block\n` +
    `- get css <site> — Read custom CSS\n` +
    `- update css <site> <css> — Update custom CSS\n\n` +
    `**Structure:**\n` +
    `- add page <site> <title> — Create a new page\n` +
    `- delete page <site> <page> — Delete a page\n\n` +
    `I also monitor your sessions and alert you before they expire.`,
  );
}

import { deleteSession } from "./db.js";

async function handleLogout(handle: string, send: SendFn): Promise<void> {
  deleteSession(handle);
  getSqspClient(handle).kill();
  await send("Disconnected. Your Squarespace session has been removed.");
}

async function handleListSites(client: import("./sqsp-client.js").SqspClient, send: SendFn): Promise<void> {
  const result = await client.call<Array<{ id: string; name: string; subdomain: string; customDomain?: string }>>("sq_list_sites", {});
  if (!result || result.length === 0) {
    await send("No sites found. Your session may need refreshing — send `login`.");
    return;
  }
  const lines = result.map((s) => `- **${s.name}** (${s.customDomain || s.subdomain + ".squarespace.com"})`);
  await send(`Your sites (${result.length}):\n\n${lines.join("\n")}`);
}

async function handleStatus(client: import("./sqsp-client.js").SqspClient, send: SendFn): Promise<void> {
  const result = await client.call<{ status: string; ageHours?: number; sites?: Array<{ name: string; hasSession: boolean; hasCrumb: boolean }> }>("sq_login", {});
  if (result.status === "healthy") {
    const siteLines = result.sites?.map((s) => `- ${s.name}: ${s.hasSession && s.hasCrumb ? "healthy" : "needs re-auth"}`).join("\n") || "No per-site data";
    await send(`Session healthy (${result.ageHours?.toFixed(1)}h old).\n\n${siteLines}`);
  } else {
    await send(`Session ${result.status}. Send \`login\` to reconnect.`);
  }
}

async function handleListPages(client: import("./sqsp-client.js").SqspClient, siteId: string, send: SendFn): Promise<void> {
  const result = await client.call<{ pages: Array<{ title: string; slug: string; type: string }> }>("sq_list_pages", { siteId });
  if (!result.pages || result.pages.length === 0) {
    await send(`No pages found on ${siteId}.`);
    return;
  }
  const lines = result.pages.map((p) => `- **${p.title}** (/${p.slug})`);
  await send(`Pages on ${siteId} (${result.pages.length}):\n\n${lines.join("\n")}`);
}

async function handleReadPage(client: import("./sqsp-client.js").SqspClient, siteId: string, pageSlug: string, send: SendFn): Promise<void> {
  const result = await client.call<{ text: string }>("sq_read_page", { siteId, pageSlug });
  const content = result.text || "(empty page)";
  // Truncate if too long for MMP message
  const truncated = content.length > 2000 ? content.slice(0, 2000) + "\n\n...(truncated)" : content;
  await send(`**${siteId}/${pageSlug}:**\n\n${truncated}`);
}

async function handleUpdateText(client: import("./sqsp-client.js").SqspClient, siteId: string, pageSlug: string, blockId: string, newText: string, send: SendFn): Promise<void> {
  await client.callTool("sq_update_text", { siteId, pageSlug, blockId, newText });
  await send(`Updated text block "${blockId}" on ${siteId}/${pageSlug}.`);
}

async function handleUpdateAnnouncement(client: import("./sqsp-client.js").SqspClient, siteId: string, text: string, send: SendFn): Promise<void> {
  await client.callTool("sq_update_announcement_bar", { siteId, text, enabled: true });
  await send(`Announcement bar updated on ${siteId}: "${text}"`);
}

async function handleAddBlogPost(client: import("./sqsp-client.js").SqspClient, siteId: string, title: string, body: string, send: SendFn): Promise<void> {
  await client.callTool("sq_create_blog_post", { siteId, title, body });
  await send(`Blog post "${title}" created on ${siteId}.`);
}

async function handleUploadImage(client: import("./sqsp-client.js").SqspClient, siteId: string, imageUrl: string, send: SendFn): Promise<void> {
  const result = await client.call<{ assetUrl?: string }>("sq_upload_image", { siteId, imageUrl });
  await send(`Image uploaded to ${siteId}.\n\nURL: ${result.assetUrl || "(processing)"}`);
}

async function handleUpdateMenu(client: import("./sqsp-client.js").SqspClient, siteId: string, pageSlug: string, content: string, send: SendFn): Promise<void> {
  await client.callTool("sq_update_menu", { siteId, pageSlug, menuText: content });
  await send(`Menu updated on ${siteId}/${pageSlug}.`);
}

async function handleGetCss(client: import("./sqsp-client.js").SqspClient, siteId: string, send: SendFn): Promise<void> {
  const result = await client.call<{ css: string }>("sq_get_design", { siteId });
  const css = result.css || "(no custom CSS)";
  const truncated = css.length > 2000 ? css.slice(0, 2000) + "\n...(truncated)" : css;
  await send(`Custom CSS for ${siteId}:\n\n\`\`\`css\n${truncated}\n\`\`\``);
}

async function handleUpdateCss(client: import("./sqsp-client.js").SqspClient, siteId: string, css: string, send: SendFn): Promise<void> {
  await client.callTool("sq_update_css", { siteId, css });
  await send(`Custom CSS updated on ${siteId}.`);
}

async function handleAddPage(client: import("./sqsp-client.js").SqspClient, siteId: string, title: string, send: SendFn): Promise<void> {
  await client.callTool("sq_create_page", { siteId, title, navigation: "mainNav" });
  await send(`Page "${title}" created on ${siteId} and added to navigation.`);
}

async function handleDeletePage(handle: string, client: import("./sqsp-client.js").SqspClient, siteId: string, pageSlug: string, send: SendFn): Promise<void> {
  // Require confirmation for destructive actions
  setPendingConfirmation(handle, "delete_page", { siteId, pageSlug });
  await send(`Are you sure you want to delete page "${pageSlug}" on ${siteId}? Reply **yes** or **no**.`);
}

async function handleConfirmation(handle: string, confirmed: boolean, send: SendFn): Promise<void> {
  const pending = getPendingConfirmation(handle);
  if (!pending) {
    await send("Nothing to confirm.");
    return;
  }

  clearPendingConfirmation(handle);

  if (!confirmed) {
    await send("Cancelled.");
    return;
  }

  const client = getSqspClient(handle);

  if (pending.action === "delete_page") {
    const { siteId, pageSlug } = pending.args as { siteId: string; pageSlug: string };
    try {
      await client.callTool("sq_delete_page", { siteId, pageSlug });
      await send(`Page "${pageSlug}" deleted from ${siteId}.`);
    } catch (err) {
      await send(`Failed to delete page: ${(err as Error).message}`);
    }
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd /Users/timcox/tim-os/squarespace-mmp-bot && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/commands.ts
git commit -m "feat: add command parser and 18 Squarespace command handlers"
```

---

### Task 7: Monitoring cron jobs

**Files:**
- Create: `squarespace-mmp-bot/src/monitor.ts`

- [ ] **Step 1: Write monitor.ts**

```typescript
/**
 * Monitoring cron jobs for session health and site change detection.
 */

import cron from "node-cron";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import {
  getAllSessions,
  updateSessionHealth,
  logAlert,
  recentAlertExists,
  upsertSnapshot,
} from "./db.js";
import { getSqspClient } from "./sqsp-client.js";

const STORAGE_ROOT = process.env.STORAGE_ROOT || path.join(process.cwd(), "storage", "users");
const MAX_PAGES_PER_USER = 50;

type SendDmFn = (handle: string, body: string) => Promise<void>;

/**
 * Start all monitoring cron jobs.
 * @param sendDm Function to send a DM to a user handle
 */
export function startMonitoring(sendDm: SendDmFn): void {
  // Session health check — every 4 hours
  cron.schedule("0 */4 * * *", async () => {
    console.log("[monitor] Running session health check");
    try {
      await checkSessionHealth(sendDm);
    } catch (err) {
      console.error("[monitor] Session health check failed:", err);
    }
  });

  // Site change detection — every 6 hours
  cron.schedule("0 */6 * * *", async () => {
    console.log("[monitor] Running site change detection");
    try {
      await detectSiteChanges(sendDm);
    } catch (err) {
      console.error("[monitor] Site change detection failed:", err);
    }
  });

  console.log("[monitor] Monitoring started: session health every 4h, site changes every 6h");
}

/**
 * Check session file age for all users. Alert if approaching or past expiry.
 */
async function checkSessionHealth(sendDm: SendDmFn): Promise<void> {
  const sessions = getAllSessions();

  for (const session of sessions) {
    const handle = session.mmp_handle;
    const sessionFile = path.join(session.session_dir, "sqsp-session.json");

    try {
      const stats = statSync(sessionFile);
      const ageMs = Date.now() - stats.mtimeMs;
      const ageHours = ageMs / (1000 * 60 * 60);

      if (ageHours > 24) {
        updateSessionHealth(handle, false);
        if (!recentAlertExists(handle, "session_expired", 4)) {
          await sendDm(handle, "Your Squarespace session has expired. Send `login` to reconnect.");
          logAlert(handle, "session_expired", `Session expired (${Math.round(ageHours)}h old)`);
        }
      } else if (ageHours > 20) {
        if (!recentAlertExists(handle, "session_expiring", 4)) {
          await sendDm(handle, `Your Squarespace session expires in ~${Math.round(24 - ageHours)}h. Send \`login\` to refresh.`);
          logAlert(handle, "session_expiring", `Session expiring (${ageHours.toFixed(1)}h old)`);
        }
      } else {
        updateSessionHealth(handle, true);
      }
    } catch {
      updateSessionHealth(handle, false);
      if (!recentAlertExists(handle, "session_missing", 4)) {
        await sendDm(handle, "No Squarespace session found. Send `login` to connect.");
        logAlert(handle, "session_missing", "Session file not found");
      }
    }
  }
}

/**
 * Check all pages for content changes since last snapshot.
 */
async function detectSiteChanges(sendDm: SendDmFn): Promise<void> {
  const sessions = getAllSessions();

  for (const session of sessions) {
    if (!session.is_healthy) continue;

    const handle = session.mmp_handle;
    const client = getSqspClient(handle);

    try {
      // List sites
      const sites = await client.call<Array<{ id: string; name: string }>>("sq_list_sites", {});
      if (!sites || sites.length === 0) continue;

      let pageCount = 0;

      for (const site of sites) {
        if (pageCount >= MAX_PAGES_PER_USER) break;

        let pages: Array<{ slug: string; title: string }>;
        try {
          const result = await client.call<{ pages: Array<{ slug: string; title: string }> }>("sq_list_pages", { siteId: site.id });
          pages = result.pages || [];
        } catch {
          continue; // Skip sites with errors
        }

        for (const page of pages) {
          if (pageCount >= MAX_PAGES_PER_USER) break;
          pageCount++;

          try {
            const result = await client.call<{ text: string }>("sq_read_page", { siteId: site.id, pageSlug: page.slug });
            const contentHash = createHash("sha256").update(result.text || "").digest("hex");

            const changed = upsertSnapshot(handle, site.id, page.slug, contentHash);
            if (changed) {
              await sendDm(
                handle,
                `Page **${page.title}** (/${page.slug}) on **${site.name}** changed since last check. Send \`read page ${site.id} ${page.slug}\` to see current content.`,
              );
              logAlert(handle, "page_changed", `${site.id}/${page.slug} content changed`);
            }
          } catch {
            // Skip pages with read errors
          }
        }
      }
    } catch (err) {
      console.error(`[monitor] Change detection failed for ${handle}:`, err);
    }
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd /Users/timcox/tim-os/squarespace-mmp-bot && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/monitor.ts
git commit -m "feat: add monitoring cron jobs for session health and site change detection"
```

---

### Task 8: Server entry point

**Files:**
- Create: `squarespace-mmp-bot/src/server.ts`

- [ ] **Step 1: Write server.ts**

```typescript
/**
 * Squarespace MMP Bot.
 * Receives MMP webhooks, routes DM commands to Squarespace MCP tools.
 */

import express from "express";
import { createHmac } from "node:crypto";
import { McpClient } from "./mmp-client.js";
import { upsertUser, upsertSession, getSession } from "./db.js";
import { handleCommand } from "./commands.js";
import { startCloudLogin } from "./auth.js";
import { startMonitoring } from "./monitor.js";

// --- Environment ---

const PORT = parseInt(process.env.PORT || "3004", 10);
const MMP_URL = process.env.MMP_URL || "https://mmp.chat/mcp";
const MMP_BOT_TOKEN = process.env.MMP_BOT_TOKEN || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

// --- MMP Client ---

const mmpUrl = MMP_BOT_TOKEN ? `${MMP_URL}?token=${MMP_BOT_TOKEN}` : MMP_URL;
const mmpClient = new McpClient(mmpUrl);

// --- Express ---

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "squarespace-mmp-bot", timestamp: new Date().toISOString() });
});

// --- Webhook ---

function verifyWebhook(body: string, signature: string | undefined): boolean {
  if (!WEBHOOK_SECRET) return true;
  if (!signature) return false;
  const expected = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
  return signature === expected;
}

interface MmpWebhookPayload {
  event: string;
  message?: {
    id: string;
    from: string;
    from_handle: string;
    body: string;
    thread_id?: string;
    is_group?: boolean;
  };
}

app.post("/webhook/mmp", async (req, res) => {
  const rawBody = JSON.stringify(req.body);
  const sig = (req.headers["x-mmp-signature"] ?? req.headers["x-webhook-signature"]) as string | undefined;
  if (!verifyWebhook(rawBody, sig)) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const payload = req.body as MmpWebhookPayload;

  try {
    if (payload.event === "message" && payload.message && !payload.message.is_group) {
      await handleDM(payload.message);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// --- Send helper ---

async function sendDM(handle: string, body: string): Promise<void> {
  try {
    await mmpClient.callTool("mmp-send", { to: `@${handle}`, body });
  } catch (err) {
    console.error(`Failed to send DM to @${handle}:`, err);
  }
}

// --- DM handler ---

async function handleDM(msg: NonNullable<MmpWebhookPayload["message"]>): Promise<void> {
  const handle = msg.from_handle;
  const userId = msg.from;
  const body = msg.body.trim();

  // Track user
  upsertUser(handle, userId);

  // Build send function for this user
  const send = (text: string) => sendDM(handle, text);

  // Build login starter
  const startLogin = async () => {
    await send("Starting cloud login... One moment.");

    const result = await startCloudLogin(handle, async (liveUrl) => {
      await send(`Open this link in your browser and log in to Squarespace:\n\n${liveUrl}\n\nI'll detect when you're done.`);
    });

    if (result.status === "success") {
      // Register session in DB
      const { SqspClient } = await import("./sqsp-client.js");
      const client = new SqspClient(handle);
      upsertSession(handle, client.sessionDir);

      // Try to discover sites
      try {
        const { getSqspClient } = await import("./sqsp-client.js");
        const sqsp = getSqspClient(handle);
        const sites = await sqsp.call<Array<{ id: string; name: string }>>("sq_list_sites", {});
        const siteNames = sites.map((s) => s.name).join(", ");
        await send(`Connected! Found ${sites.length} site(s): ${siteNames}.\n\nSend \`help\` to see what I can do.`);
      } catch {
        await send(`${result.message}\n\nSend \`help\` to see what I can do.`);
      }
    } else {
      await send(result.message);
    }
  };

  await handleCommand(handle, body, send, startLogin);
}

// --- Start ---

app.listen(PORT, () => {
  console.log(`Squarespace MMP Bot listening on port ${PORT}`);
  startMonitoring(sendDM);
});
```

- [ ] **Step 2: Build and verify**

```bash
cd /Users/timcox/tim-os/squarespace-mmp-bot && npm run build
```

Expected: clean compile, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat: add Express server with webhook handler and command routing"
```

---

### Task 9: Dockerfile and README

**Files:**
- Create: `squarespace-mmp-bot/Dockerfile`
- Create: `squarespace-mmp-bot/README.md`

- [ ] **Step 1: Write Dockerfile**

```dockerfile
FROM node:22-slim

# Install Squarespace MCP dependencies (better-sqlite3 needs build tools)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy and build bot
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Copy Squarespace MCP (pre-built)
COPY sqsp-mcp/ ./sqsp-mcp/

# Create storage directories
RUN mkdir -p /data/users

ENV PORT=3004
ENV STORAGE_ROOT=/data/users
ENV DB_PATH=/data/sqsp-bot.db
ENV SQSP_MCP_PATH=/app/sqsp-mcp/dist/src/mcp-server/index.js

EXPOSE 3004
CMD ["node", "dist/server.js"]
```

- [ ] **Step 2: Write README.md**

```markdown
# Squarespace MMP Bot

MMP bot (`@squarespace`) for managing Squarespace sites via messaging. Multi-user with Browserbase cloud auth.

## Setup

```bash
npm install
npm run build
```

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Express port (default: 3004) |
| `MMP_URL` | No | MMP server URL (default: https://mmp.chat/mcp) |
| `MMP_BOT_TOKEN` | Yes | Bot auth token for @squarespace |
| `WEBHOOK_SECRET` | Yes | HMAC secret for webhook verification |
| `BROWSERBASE_API_KEY` | Yes | Browserbase API key for cloud login |
| `BROWSERBASE_PROJECT_ID` | No | Browserbase project ID |
| `SQSP_MCP_PATH` | No | Path to Squarespace MCP index.js |
| `DB_PATH` | No | SQLite database path |
| `STORAGE_ROOT` | No | Per-user storage root |

### Running Locally

```bash
npm run dev
```

### Deploy to Railway

```bash
railway up --detach
```

## Commands

DM `@squarespace` on MMP:

- `login` — Connect your Squarespace account
- `list sites` — Show your sites
- `list pages <site>` — Pages on a site
- `read page <site> <page>` — Read page content
- `update text <site> <page> <block> <text>` — Update text
- `update announcement <site> <text>` — Set announcement bar
- `add blog post <site> "Title" Body` — Create blog post
- `status` — Session health check
- `help` — All commands

## Monitoring

- Session health check every 4 hours
- Site content change detection every 6 hours
```

- [ ] **Step 3: Commit**

```bash
git add Dockerfile README.md
git commit -m "feat: add Dockerfile and README"
```

---

### Task 10: Register MMP bot and deploy

- [ ] **Step 1: Register @squarespace on MMP**

From Claude Code with MMP configured, register the bot:

```
Call mmp-register-bot with handle "squarespace" and name "Squarespace Bot"
```

Save the token and recovery code to memory.

- [ ] **Step 2: Set up webhook on MMP**

```
Call mmp-set-webhook with url "https://squarespace-mmp-bot-production.up.railway.app/webhook/mmp"
```

Save the webhook secret to memory.

- [ ] **Step 3: Create Railway project**

```bash
cd /Users/timcox/tim-os/squarespace-mmp-bot
railway init
```

- [ ] **Step 4: Set Railway environment variables**

```bash
railway variables set MMP_BOT_TOKEN=<token from step 1>
railway variables set WEBHOOK_SECRET=<secret from step 2>
railway variables set BROWSERBASE_API_KEY=<your browserbase key>
```

- [ ] **Step 5: Copy Squarespace MCP dist into bot project**

```bash
mkdir -p /Users/timcox/tim-os/squarespace-mmp-bot/sqsp-mcp
cp -r /Users/timcox/tim-os/squarespace-mcp/dist /Users/timcox/tim-os/squarespace-mmp-bot/sqsp-mcp/dist
cp /Users/timcox/tim-os/squarespace-mcp/package.json /Users/timcox/tim-os/squarespace-mmp-bot/sqsp-mcp/
```

- [ ] **Step 6: Deploy**

```bash
cd /Users/timcox/tim-os/squarespace-mmp-bot && railway up --detach
```

- [ ] **Step 7: Verify health endpoint**

```bash
curl https://squarespace-mmp-bot-production.up.railway.app/health
```

Expected: `{"status":"ok","service":"squarespace-mmp-bot",...}`

- [ ] **Step 8: Test by DMing @squarespace on MMP**

Send "help" to @squarespace and verify you get the command list back.

- [ ] **Step 9: Save bot credentials to memory**

Save MMP bot token, recovery code, webhook secret, and Railway project ID to `/Users/timcox/.claude/projects/-Users-timcox-tim-os/memory/project_squarespace_bot.md`.

- [ ] **Step 10: Final commit**

```bash
cd /Users/timcox/tim-os/squarespace-mmp-bot
git add -A
git commit -m "chore: ready for deployment"
```
