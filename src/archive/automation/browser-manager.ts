import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { logger } from '../utils/logger.js';

const SESSION_PATH = join(process.cwd(), 'storage', 'auth', 'sqsp-session.json');

// ─── BrowserHandle Interface ─────────────────────────────────────────────────
// Common interface shared by BrowserManager (backwards compat) and BrowserSession
// (parallel execution). Any function that only needs page/context access should
// accept BrowserHandle instead of BrowserManager directly.

export interface BrowserHandle {
  getPage(): Promise<Page>;
  getContext(): Promise<BrowserContext>;
  saveSession(): Promise<void>;
  isSessionValid(): Promise<boolean>;
  hasSession(): boolean;
  isAlive(): boolean;
}

// ─── BrowserSession ──────────────────────────────────────────────────────────
// An isolated browser context + page pair for parallel execution.
// Created by BrowserManager.createSession(). Multiple sessions share one
// Chromium process but have fully isolated cookies, storage, and page state.

export class BrowserSession implements BrowserHandle {
  readonly sessionId: string;
  private context: BrowserContext;
  private page: Page;
  private manager: BrowserManager;

  constructor(sessionId: string, context: BrowserContext, page: Page, manager: BrowserManager) {
    this.sessionId = sessionId;
    this.context = context;
    this.page = page;
    this.manager = manager;
  }

  async getPage(): Promise<Page> { return this.page; }
  async getContext(): Promise<BrowserContext> { return this.context; }

  isAlive(): boolean { return this.manager.isAlive(); }
  hasSession(): boolean { return existsSync(SESSION_PATH); }

  async saveSession(): Promise<void> {
    const dir = dirname(SESSION_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    await this.context.storageState({ path: SESSION_PATH });
    logger.info({ sessionId: this.sessionId }, 'Session state saved');
  }

  async isSessionValid(): Promise<boolean> {
    try {
      await this.page.goto('https://account.squarespace.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      const url = this.page.url();
      if (url.includes('login.squarespace.com') || url.includes('/login')) {
        logger.warn({ sessionId: this.sessionId }, 'Session expired — redirect to login detected');
        return false;
      }
      logger.info({ sessionId: this.sessionId }, 'Session is valid');
      return true;
    } catch (err) {
      logger.error({ error: err, sessionId: this.sessionId }, 'Error checking session validity');
      return false;
    }
  }

  async close(): Promise<void> {
    await this.page.close().catch(() => {});
    await this.context.close().catch(() => {});
    this.manager.removeSession(this.sessionId);
    logger.info({ sessionId: this.sessionId, remainingSessions: this.manager.getActiveSessionCount() }, 'Browser session closed');
  }
}

// ─── BrowserManager ──────────────────────────────────────────────────────────

export class BrowserManager implements BrowserHandle {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private headless: boolean;
  private sessions: Map<string, BrowserSession> = new Map();

  constructor(options: { headless?: boolean } = {}) {
    this.headless = options.headless ?? false;
  }

  /** Check if the browser process is still alive and usable. */
  isAlive(): boolean {
    return this.browser !== null && this.browser.isConnected();
  }

  /** Ensure the Chromium process is running. Shared by default context and sessions. */
  private async ensureBrowser(): Promise<void> {
    if (this.browser && !this.browser.isConnected()) {
      logger.warn('Browser process is dead — cleaning up stale handles');
      this.browser = null;
      this.context = null;
      this.page = null;
      this.sessions.clear();
    }

    if (this.browser) return;

    logger.info({ headless: this.headless }, 'Launching browser');

    this.browser = await chromium.launch({
      headless: this.headless,
      slowMo: 100, // Human-like pacing to avoid detection
    });

    // Auto-recover if the browser process crashes mid-task
    this.browser.on('disconnected', () => {
      logger.warn('Browser disconnected unexpectedly — clearing handles for recovery');
      this.browser = null;
      this.context = null;
      this.page = null;
      this.sessions.clear();
    });
  }

  /** Create a new browser context + page with session cookies. */
  private async createContextAndPage(): Promise<{ context: BrowserContext; page: Page }> {
    let context: BrowserContext;
    if (existsSync(SESSION_PATH)) {
      logger.info('Loading saved session state');
      context = await this.browser!.newContext({
        storageState: SESSION_PATH,
      });
    } else {
      logger.info('No saved session — starting fresh');
      context = await this.browser!.newContext();
    }

    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });

    return { context, page };
  }

  // ─── Default Session (backwards compat for scripts, site discovery) ─────

  async initialize(): Promise<void> {
    await this.ensureBrowser();

    if (this.context && this.page) return; // Already initialized

    const { context, page } = await this.createContextAndPage();
    this.context = context;
    this.page = page;
  }

  async getPage(): Promise<Page> {
    if (!this.page || !this.isAlive()) {
      await this.initialize();
    }
    return this.page!;
  }

  async getContext(): Promise<BrowserContext> {
    if (!this.context || !this.isAlive()) {
      await this.initialize();
    }
    return this.context!;
  }

  async saveSession(): Promise<void> {
    if (!this.context) return;
    const dir = dirname(SESSION_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    await this.context.storageState({ path: SESSION_PATH });
    logger.info('Session state saved');
  }

  hasSession(): boolean {
    return existsSync(SESSION_PATH);
  }

  /** Check if the current session is still valid by navigating to the account page. */
  async isSessionValid(): Promise<boolean> {
    const page = await this.getPage();
    try {
      await page.goto('https://account.squarespace.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      const url = page.url();
      if (url.includes('login.squarespace.com') || url.includes('/login')) {
        logger.warn('Session expired — redirect to login detected');
        return false;
      }
      logger.info('Session is valid');
      return true;
    } catch (err) {
      logger.error({ error: err }, 'Error checking session validity');
      return false;
    }
  }

  // ─── Named Sessions (parallel execution) ────────────────────────────────

  /**
   * Create an isolated browser session for parallel execution.
   * Each session gets its own BrowserContext + Page, sharing the same Chromium
   * process. Sessions are isolated from each other and from the default context.
   */
  async createSession(sessionId: string): Promise<BrowserSession> {
    await this.ensureBrowser();

    if (this.sessions.has(sessionId)) {
      logger.warn({ sessionId }, 'Session already exists, returning existing');
      return this.sessions.get(sessionId)!;
    }

    const { context, page } = await this.createContextAndPage();
    const session = new BrowserSession(sessionId, context, page, this);
    this.sessions.set(sessionId, session);

    logger.info({ sessionId, activeSessions: this.sessions.size }, 'Browser session created');
    return session;
  }

  /** Remove a session from tracking (called by BrowserSession.close()). */
  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);

    // If no sessions and no default context, close the browser process
    if (this.sessions.size === 0 && !this.context) {
      this.closeBrowser();
    }
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  // ─── Cleanup ─────────────────────────────────────────────────────────────

  /** Close the default context only. Browser stays alive if sessions exist. */
  async close(): Promise<void> {
    if (this.page) {
      await this.page.close().catch(() => {});
      this.page = null;
    }
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }

    if (this.sessions.size === 0) {
      await this.closeBrowser();
    } else {
      logger.info({ activeSessions: this.sessions.size }, 'Default context closed, browser kept alive for active sessions');
    }
  }

  /** Close everything — all sessions, default context, and the browser process. */
  async closeAll(): Promise<void> {
    // Close all named sessions
    for (const [id, session] of this.sessions) {
      await session.close();
    }
    this.sessions.clear();

    // Close default context
    if (this.page) {
      await this.page.close().catch(() => {});
      this.page = null;
    }
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }

    await this.closeBrowser();
  }

  private async closeBrowser(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
    logger.info('Browser closed');
  }
}

// Singleton instance
let instance: BrowserManager | null = null;

export function getBrowserManager(options?: { headless?: boolean }): BrowserManager {
  if (!instance) {
    instance = new BrowserManager(options);
  }
  return instance;
}

/** Clean up any active browser on process exit. */
export async function shutdownBrowser(): Promise<void> {
  if (instance) {
    await instance.closeAll();
    instance = null;
  }
}
