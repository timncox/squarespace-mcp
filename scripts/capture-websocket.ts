/**
 * WebSocket & Content Save Capture Script
 *
 * Captures ALL network traffic (HTTP + WebSocket) during Squarespace editor
 * text and CSS editing to discover the actual save endpoints.
 *
 * Key findings from research: Squarespace does NOT use WebSockets for content
 * saves — it uses standard REST/HTTP POST. This script confirms that and
 * captures the actual HTTP save endpoints.
 *
 * Features:
 * - page.on('websocket') to log any WS connections (expected: none for saves)
 * - page.on('request'/'response') with broad URL matching to capture all HTTP
 * - Service workers BLOCKED to prevent request interception
 * - Performs a text edit + CSS edit while capturing
 * - Outputs full capture to data/ws-capture-{timestamp}.json
 *
 * Usage:
 *   npx tsx scripts/capture-websocket.ts
 *   npx tsx scripts/capture-websocket.ts --site grey-yellow-hbxc
 *   npx tsx scripts/capture-websocket.ts --headless
 *   npx tsx scripts/capture-websocket.ts --action text     # Only text edit
 *   npx tsx scripts/capture-websocket.ts --action css      # Only CSS edit
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { chromium, Page, Request, Response, Browser, BrowserContext, WebSocket } from 'playwright';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import { discoverSites } from '../src/automation/site-discovery.js';
import { resolveSite, navigateToSite, navigateToPage, enterEditMode } from '../src/automation/site-navigator.js';
import { clickThroughOverlay, dblclickThroughOverlay, getSiteFrame } from '../src/automation/editor-actions.js';
import { isFluidEngineActive, clickEditorButton } from '../src/automation/actions/handler-utils.js';
import { logger } from '../src/utils/logger.js';
import { errMsg } from '../src/utils/errors.js';

const SESSION_PATH = join(process.cwd(), 'storage', 'auth', 'sqsp-session.json');

// ── Types ─────────────────────────────────────────────────────────────────

interface CapturedWSConnection {
  url: string;
  openedAt: string;
  closedAt: string | null;
  framesSent: { timestamp: string; data: string }[];
  framesReceived: { timestamp: string; data: string }[];
}

interface CapturedHTTPRequest {
  timestamp: string;
  method: string;
  url: string;
  path: string;
  contentType: string;
  bodySize: number;
  bodySnippet: string | null;
  responseStatus: number | null;
  responseBodySnippet: string | null;
  phase: string;
}

// ── CLI Flags ─────────────────────────────────────────────────────────────

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : 'true';
      flags[key] = value;
      if (value !== 'true') i++;
    }
  }
  return flags;
}

// ── Noise filter — skip analytics/static/CDN ──────────────────────────────

const NOISE_PATTERNS = [
  /\/api\/census/, /\/api\/beacon/,
  /\/api\/1\/performance/, /\/api\/rollups/,
  /\/universal\/images-cdn\//, /\/static\//,
  /\.js(\?|$)/, /\.css(\?|$)/, /\.woff2?(\?|$)/,
  /\.png(\?|$)/, /\.jpg(\?|$)/, /\.svg(\?|$)/,
  /\/favicon/, /google-analytics/, /googletagmanager/,
  /hotjar/, /sentry/, /doubleclick/, /facebook/,
];

// During edit phases, capture EVERYTHING (no noise filtering)
let captureAll = false;

function isNoise(url: string): boolean {
  if (captureAll) return false;
  return NOISE_PATTERNS.some(p => p.test(url));
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const siteId = flags.site ?? 'grey-yellow-hbxc';
  const headless = flags.headless === 'true';
  const actionFilter = flags.action ?? 'both'; // 'text', 'css', or 'both'

  console.log('\n' + '='.repeat(70));
  console.log('  WEBSOCKET & CONTENT SAVE CAPTURE');
  console.log('  Captures WS frames + HTTP traffic during editor edits');
  console.log('='.repeat(70));
  console.log(`  Site: ${siteId}`);
  console.log(`  Actions: ${actionFilter}`);
  console.log(`  Headless: ${headless}`);
  console.log('');

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  const wsConnections: CapturedWSConnection[] = [];
  const httpCaptures: CapturedHTTPRequest[] = [];
  let currentPhase = 'setup';

  try {
    // ── Launch browser with service workers blocked ───────────────────
    console.log('  [1/6] Launching browser (service workers BLOCKED)...');
    browser = await chromium.launch({ headless, slowMo: 50 });

    const contextOptions: Record<string, unknown> = {
      serviceWorkers: 'block' as const,
    };
    if (existsSync(SESSION_PATH)) {
      contextOptions.storageState = SESSION_PATH;
    }
    context = await browser.newContext(contextOptions);
    page = await context.newPage();

    // ── Verify login ─────────────────────────────────────────────────
    await page.goto('https://account.squarespace.com/project-picker', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    if (page.url().includes('/login') || page.url().includes('/signin')) {
      console.log('  ERROR: Not logged in. Run a normal session first to save cookies.');
      process.exit(1);
    }
    console.log('  Login verified');

    // ── Navigate to site ─────────────────────────────────────────────
    console.log('  [2/6] Navigating to site...');
    await discoverSites(page);
    const client = await resolveSite(siteId, page);
    console.log(`  Resolved: ${client.name}`);
    await navigateToSite(page, client);
    await navigateToPage(page, client, 'home');

    // ── Set up WebSocket monitoring ──────────────────────────────────
    console.log('  [3/6] Setting up WebSocket + HTTP capture...\n');

    page.on('websocket', (ws: WebSocket) => {
      const conn: CapturedWSConnection = {
        url: ws.url(),
        openedAt: new Date().toISOString(),
        closedAt: null,
        framesSent: [],
        framesReceived: [],
      };
      wsConnections.push(conn);

      console.log('  *** WEBSOCKET OPENED ***');
      console.log(`  *** URL: ${ws.url()}`);
      console.log('  *** Phase: ' + currentPhase);

      ws.on('framesent', (data) => {
        const payload = typeof data.payload === 'string'
          ? data.payload.substring(0, 2000)
          : `[binary: ${(data.payload as Buffer).length} bytes]`;
        conn.framesSent.push({
          timestamp: new Date().toISOString(),
          data: payload,
        });
        console.log(`  >>> WS SENT (${currentPhase}): ${payload.substring(0, 200)}`);
      });

      ws.on('framereceived', (data) => {
        const payload = typeof data.payload === 'string'
          ? data.payload.substring(0, 2000)
          : `[binary: ${(data.payload as Buffer).length} bytes]`;
        conn.framesReceived.push({
          timestamp: new Date().toISOString(),
          data: payload,
        });
        console.log(`  <<< WS RECV (${currentPhase}): ${payload.substring(0, 200)}`);
      });

      ws.on('close', () => {
        conn.closedAt = new Date().toISOString();
        console.log(`  *** WEBSOCKET CLOSED: ${ws.url()}`);
      });
    });

    // ── Set up route-level interception for guaranteed capture ──────
    // Use context.route() to intercept ALL frames (main + iframe)
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = request.url();
      const method = request.method();

      // During edit phases, log ALL mutating requests to squarespace.com
      if (captureAll && method !== 'GET') {
        try {
          const parsedUrl = new URL(url);
          const host = parsedUrl.hostname;
          if (host.includes('squarespace.com')) {
            const frameName = request.frame()?.name() || 'unknown';
            console.log(`  *** [ROUTE:${frameName}][${currentPhase}] ${method} ${url.substring(0, 150)}`);
            const postData = request.postData();
            if (postData) {
              console.log(`      Body (${postData.length} bytes): ${postData.substring(0, 500)}`);
            }

            // Capture in our list
            const entry: CapturedHTTPRequest = {
              timestamp: new Date().toISOString(),
              method,
              url,
              path: parsedUrl.pathname,
              contentType: request.headers()['content-type'] || '',
              bodySize: postData?.length ?? 0,
              bodySnippet: postData?.substring(0, 2000) ?? null,
              responseStatus: null,
              responseBodySnippet: null,
              phase: `${currentPhase}:route:${frameName}`,
            };
            httpCaptures.push(entry);
          }
        } catch { /* URL parse error */ }
      }

      await route.continue();
    });

    // ── Set up HTTP monitoring (non-GET mutating requests) ───────────
    page.on('request', (request: Request) => {
      const url = request.url();
      const method = request.method();
      if (method === 'GET' || isNoise(url)) return;

      let bodySnippet: string | null = null;
      const postData = request.postData();
      if (postData) {
        bodySnippet = postData.substring(0, 2000);
      }

      const parsedUrl = new URL(url);
      const entry: CapturedHTTPRequest = {
        timestamp: new Date().toISOString(),
        method,
        url,
        path: parsedUrl.pathname,
        contentType: request.headers()['content-type'] || '',
        bodySize: postData?.length ?? 0,
        bodySnippet,
        responseStatus: null,
        responseBodySnippet: null,
        phase: currentPhase,
      };
      httpCaptures.push(entry);

      console.log(`  [${currentPhase}] ${method} ${url.substring(0, 150)}`);
      if (entry.contentType) console.log(`    Content-Type: ${entry.contentType}`);
      if (entry.bodySize > 0) console.log(`    Body: ${entry.bodySize} bytes`);
    });

    page.on('response', async (response: Response) => {
      const request = response.request();
      const method = request.method();
      const url = request.url();
      if (method === 'GET' || isNoise(url)) return;

      // Find matching capture entry and update with response
      const match = [...httpCaptures].reverse().find(
        e => e.url === url && e.method === method && e.responseStatus === null
      );
      if (match) {
        match.responseStatus = response.status();
        try {
          const body = await response.text().catch(() => '');
          if (body.length > 0 && body.length < 10000) {
            match.responseBodySnippet = body.substring(0, 2000);
          } else if (body.length >= 10000) {
            match.responseBodySnippet = `[${body.length} bytes truncated] ${body.substring(0, 500)}`;
          }
        } catch { /* response body not always available */ }

        console.log(`    → ${response.status()} ${url.substring(0, 120)}`);
      }
    });

    // ── Enter edit mode ──────────────────────────────────────────────
    console.log('  [4/6] Entering edit mode...');
    currentPhase = 'enter-edit-mode';
    await enterEditMode(page);
    await page.waitForTimeout(2000);

    const captureCountBeforeEdits = httpCaptures.length;

    // ── ACTION: Text edit ────────────────────────────────────────────
    if (actionFilter === 'text' || actionFilter === 'both') {
      console.log('\n  [5/6] TEXT EDIT — typing in a text block...');
      console.log('  ' + '-'.repeat(60));
      currentPhase = 'text-edit';
      captureAll = true;

      // ── Hook navigator.sendBeacon in ALL frames ──────────────────
      const beaconHook = `
        if (!window.__beaconHooked) {
          window.__beaconHooked = true;
          window.__beaconCalls = [];
          const origBeacon = navigator.sendBeacon.bind(navigator);
          navigator.sendBeacon = function(url, data) {
            const entry = { url, dataLength: data?.length || data?.size || 0, dataSnippet: '' };
            try { entry.dataSnippet = typeof data === 'string' ? data.substring(0, 500) : '[non-string]'; } catch {}
            window.__beaconCalls.push(entry);
            console.log('[BEACON] ' + url + ' (' + entry.dataLength + ' bytes)');
            return origBeacon(url, data);
          };
        }
      `;
      // Hook main frame
      await page.evaluate(beaconHook);
      // Hook iframe
      const iframeFrame = page.frame({ name: 'sqs-site-frame' });
      if (iframeFrame) {
        await iframeFrame.evaluate(beaconHook).catch(() => console.log('    Could not hook beacon in iframe'));
      }

      // ── Hook XMLHttpRequest.send in ALL frames ───────────────────
      const xhrHook = `
        if (!window.__xhrHooked) {
          window.__xhrHooked = true;
          window.__xhrCalls = [];
          const origOpen = XMLHttpRequest.prototype.open;
          const origSend = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.open = function(method, url) {
            this.__captureMethod = method;
            this.__captureUrl = url;
            return origOpen.apply(this, arguments);
          };
          XMLHttpRequest.prototype.send = function(body) {
            if (this.__captureMethod !== 'GET') {
              const entry = { method: this.__captureMethod, url: this.__captureUrl, bodyLength: body?.length || 0 };
              window.__xhrCalls.push(entry);
              console.log('[XHR] ' + this.__captureMethod + ' ' + this.__captureUrl + ' (' + entry.bodyLength + ' bytes)');
            }
            return origSend.apply(this, arguments);
          };
        }
      `;
      await page.evaluate(xhrHook);
      if (iframeFrame) {
        await iframeFrame.evaluate(xhrHook).catch(() => console.log('    Could not hook XHR in iframe'));
      }

      // ── Monitor console messages for our hooks ───────────────────
      page.on('console', (msg) => {
        const text = msg.text();
        if (text.startsWith('[BEACON]') || text.startsWith('[XHR]')) {
          console.log(`  *** INTERCEPTED: ${text}`);
        }
      });

      // ── Use CDP Fetch domain for lowest-level interception ───────
      const cdpSession = await page.context().newCDPSession(page);
      await cdpSession.send('Fetch.enable', {
        patterns: [{ urlPattern: '*squarespace.com*', requestStage: 'Request' }],
      });
      cdpSession.on('Fetch.requestPaused', async (event) => {
        const { requestId, request } = event;
        if (request.method !== 'GET') {
          console.log(`  *** [CDP][${currentPhase}] ${request.method} ${request.url.substring(0, 150)}`);
          if (request.postData) {
            console.log(`      Body (${request.postData.length} chars): ${request.postData.substring(0, 500)}`);
          }
          httpCaptures.push({
            timestamp: new Date().toISOString(),
            method: request.method,
            url: request.url,
            path: new URL(request.url).pathname,
            contentType: request.headers['content-type'] || request.headers['Content-Type'] || '',
            bodySize: request.postData?.length ?? 0,
            bodySnippet: request.postData?.substring(0, 2000) ?? null,
            responseStatus: null,
            responseBodySnippet: null,
            phase: `${currentPhase}:cdp`,
          });
        }
        await cdpSession.send('Fetch.continueRequest', { requestId });
      });
      console.log('    CDP Fetch interception enabled');

      // ── Step 1: Find a text block in the iframe ──────────────────
      const siteFrame = getSiteFrame(page);
      const siteFrameObj = page.frame({ name: 'sqs-site-frame' });

      // Use text-block-specific selectors (same as text-editing-handlers.ts)
      const TEXT_BLOCK_SELECTORS = [
        '.sqs-block-html .sqs-block-content',
        '.sqs-block-html .html-block',
        '[data-block-type="2"] .sqs-block-content',
        '.fe-block .sqs-block-content',
      ];

      let textBlockSelector: string | null = null;
      let textBefore: string | null = null;
      const siteFrameLocator = page.frameLocator('#sqs-site-frame');

      for (const sel of TEXT_BLOCK_SELECTORS) {
        const el = siteFrameLocator.locator(sel).first();
        if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
          const content = await el.textContent().catch(() => '');
          if (content && content.trim().length > 5) {
            textBlockSelector = sel;
            textBefore = content.trim();
            break;
          }
        }
      }

      if (!textBlockSelector || !textBefore) {
        console.log('    WARNING: No text block with content found');
        console.log('    Tried selectors:', TEXT_BLOCK_SELECTORS.join(', '));
      } else {
        console.log(`    Found text block via: ${textBlockSelector}`);
        console.log(`    Text before: "${textBefore.substring(0, 80)}"`);

        // ── Step 2: Click the text block through overlay (selects section) ──
        console.log('    Clicking text block through overlay (selects section)...');
        const clickResult = await clickThroughOverlay(page, textBlockSelector);
        console.log(`    Click result: ${clickResult.message}`);
        await page.waitForTimeout(2000);

        // ── Step 3: Enter Fluid Engine edit mode ──────────────────
        const fluidActive = await isFluidEngineActive(page, 3000);
        console.log(`    Fluid Engine active: ${fluidActive}`);

        if (!fluidActive) {
          const editClicked = await clickEditorButton(
            page, /edit content/i,
            ['[aria-label="Edit Content"]', 'button[data-test="edit-content"]'],
            3000
          );
          console.log(`    "Edit Content" clicked: ${editClicked}`);
          await page.waitForTimeout(2000);

          const fluidRetry = await isFluidEngineActive(page, 3000);
          console.log(`    Fluid Engine active (retry): ${fluidRetry}`);
        }

        // Wait for Fluid Engine DOM to settle
        await Promise.race([
          siteFrameLocator.locator('[class*="fluid-engine"]').first().isVisible({ timeout: 3000 }).catch(() => false),
          siteFrameLocator.locator('[class*="FluidEngine"]').first().isVisible({ timeout: 3000 }).catch(() => false),
          new Promise<boolean>(r => setTimeout(() => r(true), 3000)),
        ]);

        // ── Step 4: Double-click to enter inline edit mode ────────
        console.log('    Double-clicking text block through overlay (enters inline edit)...');
        const dblResult = await dblclickThroughOverlay(page, textBlockSelector);
        console.log(`    Dblclick result: ${dblResult.message}`);
        await page.waitForTimeout(2000);

        // ── Step 5: Verify contenteditable is active ──────────────
        let editorActive = false;
        if (siteFrameObj) {
          editorActive = await siteFrameObj.evaluate(() => {
            const active = document.activeElement;
            if (active && (active as HTMLElement).isContentEditable) return true;
            const editableEls = document.querySelectorAll('[contenteditable="true"]');
            for (const el of editableEls) {
              if (el === document.activeElement) return true;
              const sel = window.getSelection();
              if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) return true;
            }
            const toolbar = document.querySelector('.sqs-editing-toolbar, .rte-toolbar, [data-rte-toolbar]');
            return !!toolbar;
          }).catch(() => false);
        }
        console.log(`    contenteditable active: ${editorActive}`);

        // Fallback: Synthetic event dispatch (Strategy 2 from editTextBlock)
        if (!editorActive && siteFrameObj) {
          console.log('    Trying synthetic event dispatch...');
          const synthResult = await siteFrameObj.evaluate((searchText: string) => {
            const lower = searchText.toLowerCase().substring(0, 30);
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
              const node = walker.currentNode;
              if (node.textContent && node.textContent.trim().toLowerCase().includes(lower)) {
                const target = node.parentElement;
                if (!target) continue;
                const rect = target.getBoundingClientRect();
                const x = rect.left + rect.width / 2;
                const y = rect.top + rect.height / 2;
                const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
                target.dispatchEvent(new MouseEvent('mousedown', opts));
                target.dispatchEvent(new MouseEvent('mouseup', opts));
                target.dispatchEvent(new MouseEvent('click', opts));
                target.dispatchEvent(new MouseEvent('mousedown', opts));
                target.dispatchEvent(new MouseEvent('mouseup', opts));
                target.dispatchEvent(new MouseEvent('click', opts));
                target.dispatchEvent(new MouseEvent('dblclick', opts));
                target.focus();
                return { tag: target.tagName, text: target.textContent?.substring(0, 40) };
              }
            }
            return null;
          }, textBefore).catch(() => null);
          console.log(`    Synthetic events: ${synthResult ? `hit ${synthResult.tag}` : 'no match'}`);
          await page.waitForTimeout(1000);

          // Re-check editor state
          editorActive = await siteFrameObj.evaluate(() => {
            const active = document.activeElement;
            if (active && (active as HTMLElement).isContentEditable) return true;
            const toolbar = document.querySelector('.sqs-editing-toolbar, .rte-toolbar, [data-rte-toolbar]');
            return !!toolbar;
          }).catch(() => false);
          console.log(`    contenteditable active (after synth): ${editorActive}`);
        }

        // Fallback: Force contentEditable (Strategy 4 from editTextBlock)
        if (!editorActive && siteFrameObj) {
          console.log('    Trying force contentEditable...');
          const forceResult = await siteFrameObj.evaluate((searchText: string) => {
            const lower = searchText.toLowerCase().substring(0, 30);
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
              const node = walker.currentNode;
              if (node.textContent && node.textContent.trim().toLowerCase().includes(lower)) {
                const parent = node.parentElement;
                if (!parent) continue;
                const block = parent.closest('.sqs-block');
                if (!block) continue;
                let editableEl = block.querySelector('[contenteditable="true"]') as HTMLElement | null;
                if (!editableEl) {
                  editableEl = (block.querySelector('p, h1, h2, h3, h4, h5, h6') ||
                               block.querySelector('.sqs-block-content')) as HTMLElement;
                }
                if (editableEl) {
                  editableEl.setAttribute('contenteditable', 'true');
                  editableEl.focus();
                  const range = document.createRange();
                  range.selectNodeContents(editableEl);
                  const sel = window.getSelection();
                  if (sel) { sel.removeAllRanges(); sel.addRange(range); }
                  return 'force-editable';
                }
              }
            }
            return null;
          }, textBefore).catch(() => null);
          console.log(`    Force contentEditable: ${forceResult ?? 'failed'}`);
          await page.waitForTimeout(500);
        }

        // ── Step 6: Select all and type ───────────────────────────
        console.log('    Typing "CAPTURE_TEST"...');
        currentPhase = 'text-edit-typing';
        await page.keyboard.press('Meta+a');
        await page.waitForTimeout(200);
        await page.keyboard.type('CAPTURE_TEST', { delay: 20 });
        await page.waitForTimeout(2000);

        // Verify text was entered
        let textEntered = false;
        if (siteFrameObj) {
          textEntered = await siteFrameObj.evaluate((text: string) => {
            return document.body.innerText.includes(text);
          }, 'CAPTURE_TEST').catch(() => false);
        }
        console.log(`    *** Text entry ${textEntered ? 'CONFIRMED' : 'FAILED'} ***`);

        // If keyboard typing failed, try direct DOM replacement
        if (!textEntered && siteFrameObj) {
          console.log('    Trying direct DOM replacement as last resort...');
          const domReplaced = await siteFrameObj.evaluate((args: { oldText: string; newText: string }) => {
            const lower = args.oldText.toLowerCase().substring(0, 30);
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
              const node = walker.currentNode;
              if (node.textContent && node.textContent.trim().toLowerCase().includes(lower)) {
                const parent = node.parentElement;
                const block = parent?.closest('.sqs-block');
                if (!block) continue;
                // Append rather than replace so the original text is still findable
                node.textContent = node.textContent + ' CAPTURE_TEST';
                parent?.dispatchEvent(new Event('input', { bubbles: true }));
                parent?.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
              }
            }
            return false;
          }, { oldText: textBefore, newText: 'CAPTURE_TEST' }).catch(() => false);
          textEntered = domReplaced;
          console.log(`    DOM replacement: ${domReplaced ? 'SUCCESS' : 'FAILED'}`);
        }

        // Take a screenshot to debug what's on screen
        const debugSsPath = join(process.cwd(), 'storage', 'screenshots', `text-edit-debug-${Date.now()}.png`);
        await page.screenshot({ path: debugSsPath });
        console.log(`    Debug screenshot: ${debugSsPath}`);

        if (textEntered) {
          // === SAVE ATTEMPT 1: Cmd+S ===
          console.log('\n    --- Save attempt 1: Cmd+S ---');
          currentPhase = 'text-edit-save-cmds';
          await page.keyboard.press('Meta+s');
          await page.waitForTimeout(5000);

          // === SAVE ATTEMPT 2: Click outside (blur) ===
          console.log('    --- Save attempt 2: Click outside ---');
          currentPhase = 'text-edit-save-blur';
          await page.mouse.click(600, 500);
          await page.waitForTimeout(5000);

          // === SAVE ATTEMPT 3: Exit section edit mode (Escape) ===
          console.log('    --- Save attempt 3: Exit edit mode (Escape) ---');
          currentPhase = 'text-edit-save-escape';
          await page.keyboard.press('Escape');
          await page.waitForTimeout(3000);
          await page.keyboard.press('Escape');
          await page.waitForTimeout(5000);

          // === SAVE ATTEMPT 4: Navigate away (triggers unload) ===
          console.log('    --- Save attempt 4: Navigate away ---');
          currentPhase = 'text-edit-save-navigate';
          const siteMatch = page.url().match(/https:\/\/([^.]+)\.squarespace\.com/);
          if (siteMatch) {
            await page.goto(`https://${siteMatch[1]}.squarespace.com/config/pages`, {
              waitUntil: 'domcontentloaded',
              timeout: 15000,
            });
            await page.waitForTimeout(5000);
          }
        } else {
          console.log('    Skipping save attempts (text entry failed)');
        }

        // === Check beacon + XHR hooks ===
        console.log('\n    --- Checking intercepted calls ---');
        const beaconCalls = await page.evaluate('window.__beaconCalls || []').catch(() => []);
        console.log(`    Beacon calls: ${(beaconCalls as unknown[]).length}`);
        for (const call of beaconCalls as Array<{url: string; dataLength: number; dataSnippet: string}>) {
          console.log(`      [BEACON] ${call.url} (${call.dataLength} bytes)`);
          if (call.dataSnippet) console.log(`        ${call.dataSnippet.substring(0, 300)}`);
        }

        const xhrCalls = await page.evaluate('window.__xhrCalls || []').catch(() => []);
        console.log(`    XHR calls: ${(xhrCalls as unknown[]).length}`);
        for (const call of xhrCalls as Array<{method: string; url: string; bodyLength: number}>) {
          console.log(`      [XHR] ${call.method} ${call.url} (${call.bodyLength} bytes)`);
        }

        console.log('    Text edit capture complete');
      }

      // Disable CDP Fetch to avoid interfering with CSS capture
      await cdpSession.send('Fetch.disable').catch(() => {});
    }

    // ── ACTION: CSS edit ─────────────────────────────────────────────
    if (actionFilter === 'css' || actionFilter === 'both') {
      console.log('\n  [6/6] CSS EDIT — typing in Custom CSS editor...');
      console.log('  ' + '-'.repeat(60));
      currentPhase = 'css-navigate';

      captureAll = true; // Capture everything during CSS edits
      const siteMatch = page.url().match(/https:\/\/([^.]+)\.squarespace\.com/);
      if (siteMatch) {
        // Correct URL: /config/design/custom-css (NOT /config/pages/website-tools/custom-css)
        const cssUrl = `https://${siteMatch[1]}.squarespace.com/config/design/custom-css`;
        console.log(`    Navigating to: ${cssUrl}`);
        await page.goto(cssUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(4000);

        // ── Inject XHR/beacon hooks + CDP Fetch for CSS page ──────
        const beaconHookCSS = `
          if (!window.__beaconHooked) {
            window.__beaconHooked = true;
            window.__beaconCalls = [];
            const origBeacon = navigator.sendBeacon.bind(navigator);
            navigator.sendBeacon = function(url, data) {
              const entry = { url, dataLength: data?.length || data?.size || 0, dataSnippet: '' };
              try { entry.dataSnippet = typeof data === 'string' ? data.substring(0, 500) : '[non-string]'; } catch {}
              window.__beaconCalls.push(entry);
              console.log('[BEACON] ' + url + ' (' + entry.dataLength + ' bytes)');
              return origBeacon(url, data);
            };
          }
        `;
        const xhrHookCSS = `
          if (!window.__xhrHooked) {
            window.__xhrHooked = true;
            window.__xhrCalls = [];
            const origOpen = XMLHttpRequest.prototype.open;
            const origSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.open = function(method, url) {
              this.__captureMethod = method;
              this.__captureUrl = url;
              return origOpen.apply(this, arguments);
            };
            XMLHttpRequest.prototype.send = function(body) {
              if (this.__captureMethod !== 'GET') {
                const entry = { method: this.__captureMethod, url: this.__captureUrl, bodyLength: body?.length || 0, bodySnippet: '' };
                try { entry.bodySnippet = typeof body === 'string' ? body.substring(0, 500) : '[non-string]'; } catch {}
                window.__xhrCalls.push(entry);
                console.log('[XHR] ' + this.__captureMethod + ' ' + this.__captureUrl + ' (' + entry.bodyLength + ' bytes)');
              }
              return origSend.apply(this, arguments);
            };
          }
        `;
        // Also hook fetch() to catch modern API calls
        const fetchHookCSS = `
          if (!window.__fetchHooked) {
            window.__fetchHooked = true;
            window.__fetchCalls = [];
            const origFetch = window.fetch.bind(window);
            window.fetch = function(input, init) {
              const method = (init?.method || 'GET').toUpperCase();
              const url = typeof input === 'string' ? input : input.url;
              if (method !== 'GET') {
                const bodyLen = init?.body ? (typeof init.body === 'string' ? init.body.length : init.body.byteLength || 0) : 0;
                const bodySnippet = init?.body && typeof init.body === 'string' ? init.body.substring(0, 500) : '[non-string]';
                window.__fetchCalls.push({ method, url, bodyLength: bodyLen, bodySnippet });
                console.log('[FETCH] ' + method + ' ' + url + ' (' + bodyLen + ' bytes)');
              }
              return origFetch(input, init);
            };
          }
        `;
        await page.evaluate(beaconHookCSS);
        await page.evaluate(xhrHookCSS);
        await page.evaluate(fetchHookCSS);
        console.log('    Injected XHR/beacon/fetch hooks');

        // Monitor console messages for our hooks
        page.on('console', (msg) => {
          const text = msg.text();
          if (text.startsWith('[BEACON]') || text.startsWith('[XHR]') || text.startsWith('[FETCH]')) {
            console.log(`  *** CSS INTERCEPTED: ${text}`);
          }
        });

        // Enable CDP Fetch for CSS page
        const cdpSessionCSS = await page.context().newCDPSession(page);
        await cdpSessionCSS.send('Fetch.enable', {
          patterns: [{ urlPattern: '*squarespace.com*', requestStage: 'Request' }],
        });
        cdpSessionCSS.on('Fetch.requestPaused', async (event) => {
          const { requestId, request } = event;
          if (request.method !== 'GET') {
            console.log(`  *** [CDP-CSS][${currentPhase}] ${request.method} ${request.url.substring(0, 150)}`);
            if (request.postData) {
              console.log(`      Body (${request.postData.length} chars): ${request.postData.substring(0, 500)}`);
            }
            httpCaptures.push({
              timestamp: new Date().toISOString(),
              method: request.method,
              url: request.url,
              path: new URL(request.url).pathname,
              contentType: request.headers['content-type'] || request.headers['Content-Type'] || '',
              bodySize: request.postData?.length ?? 0,
              bodySnippet: request.postData?.substring(0, 2000) ?? null,
              responseStatus: null,
              responseBodySnippet: null,
              phase: `${currentPhase}:cdp`,
            });
          }
          await cdpSessionCSS.send('Fetch.continueRequest', { requestId });
        });
        console.log('    CDP Fetch interception enabled for CSS page');

        // Find CSS editor — Squarespace uses CodeMirror
        const cmEditor = page.locator('.CodeMirror').first();
        if (await cmEditor.isVisible({ timeout: 5000 }).catch(() => false)) {
          console.log('    Found CodeMirror editor');

          // Read current CSS content
          const cssBefore = await page.evaluate(() => {
            const cm = (document.querySelector('.CodeMirror') as any)?.CodeMirror;
            return cm ? cm.getValue() : null;
          }).catch(() => null);
          console.log(`    CSS before (${cssBefore?.length ?? 0} chars): "${cssBefore?.substring(0, 80)}"`);

          // Click to focus — use .CodeMirror-lines for precise focus
          const cmLines = page.locator('.CodeMirror-lines').first();
          if (await cmLines.isVisible({ timeout: 2000 }).catch(() => false)) {
            await cmLines.click();
            console.log('    Clicked .CodeMirror-lines');
          } else {
            await cmEditor.click();
            console.log('    Clicked .CodeMirror (fallback)');
          }
          await page.waitForTimeout(500);

          // Verify focus
          const hasFocus = await page.evaluate(() => {
            const cm = document.querySelector('.CodeMirror');
            return cm?.classList.contains('CodeMirror-focused') ?? false;
          }).catch(() => false);
          console.log(`    CodeMirror focused: ${hasFocus}`);

          // Go to end, add new line, type CSS
          await page.keyboard.press('Meta+End');
          await page.keyboard.press('Enter');
          console.log('    Typing CSS comment...');
          currentPhase = 'css-edit-typing';
          await page.keyboard.type('/* capture-test-css */', { delay: 10 });
          await page.waitForTimeout(1000);

          // Verify text was entered
          const cssAfter = await page.evaluate(() => {
            const cm = (document.querySelector('.CodeMirror') as any)?.CodeMirror;
            return cm ? cm.getValue() : null;
          }).catch(() => null);
          const cssEntered = cssAfter?.includes('capture-test-css');
          console.log(`    CSS after (${cssAfter?.length ?? 0} chars): "...${cssAfter?.slice(-80)}"`);
          console.log(`    *** CSS entry ${cssEntered ? 'CONFIRMED' : 'FAILED'} ***`);

          if (cssEntered) {
            // === SAVE ATTEMPT 1: Cmd+S ===
            console.log('\n    --- CSS save attempt 1: Cmd+S ---');
            currentPhase = 'css-edit-save-cmds';
            await page.keyboard.press('Meta+s');
            await page.waitForTimeout(5000);

            // Check for save toast/indicator
            const toast = await page.locator('[class*="toast"], [class*="notification"], [class*="saved"]')
              .first().isVisible({ timeout: 2000 }).catch(() => false);
            console.log(`    Save toast visible: ${toast}`);

            // === SAVE ATTEMPT 2: Navigate away (trigger save-on-leave) ===
            console.log('    --- CSS save attempt 2: Navigate away ---');
            currentPhase = 'css-edit-save-navigate';
            const siteMatchCSS = page.url().match(/https:\/\/([^.]+)\.squarespace\.com/);
            if (siteMatchCSS) {
              await page.goto(`https://${siteMatchCSS[1]}.squarespace.com/config/pages`, {
                waitUntil: 'domcontentloaded',
                timeout: 15000,
              });
              await page.waitForTimeout(5000);
            }

            // === SAVE ATTEMPT 3: Navigate back and check if CSS persisted ===
            console.log('    --- CSS save attempt 3: Check persistence ---');
            currentPhase = 'css-edit-verify';
            if (siteMatchCSS) {
              await page.goto(`https://${siteMatchCSS[1]}.squarespace.com/config/design/custom-css`, {
                waitUntil: 'domcontentloaded',
                timeout: 15000,
              });
              await page.waitForTimeout(4000);
              const cssVerify = await page.evaluate(() => {
                const cm = (document.querySelector('.CodeMirror') as any)?.CodeMirror;
                return cm ? cm.getValue() : null;
              }).catch(() => null);
              const persisted = cssVerify?.includes('capture-test-css');
              console.log(`    CSS persisted after navigation: ${persisted}`);
              console.log(`    CSS content: "...${cssVerify?.slice(-80)}"`);

              // Clean up: remove the test CSS
              if (persisted) {
                console.log('    Cleaning up test CSS...');
                currentPhase = 'css-edit-cleanup';
                await page.evaluate((original: string | null) => {
                  const cm = (document.querySelector('.CodeMirror') as any)?.CodeMirror;
                  if (cm && original !== null) cm.setValue(original);
                }, cssBefore);
                await page.keyboard.press('Meta+s');
                await page.waitForTimeout(3000);
              }
            }
          } else {
            console.log('    Skipping save attempts (CSS entry failed)');
          }

          // Check intercepted calls
          console.log('\n    --- Checking CSS intercepted calls ---');
          const cssBeaconCalls = await page.evaluate('window.__beaconCalls || []').catch(() => []);
          console.log(`    Beacon calls: ${(cssBeaconCalls as unknown[]).length}`);
          for (const call of cssBeaconCalls as Array<{url: string; dataLength: number; dataSnippet: string}>) {
            console.log(`      [BEACON] ${call.url} (${call.dataLength} bytes)`);
          }

          const cssXhrCalls = await page.evaluate('window.__xhrCalls || []').catch(() => []);
          console.log(`    XHR calls: ${(cssXhrCalls as unknown[]).length}`);
          for (const call of cssXhrCalls as Array<{method: string; url: string; bodyLength: number; bodySnippet: string}>) {
            console.log(`      [XHR] ${call.method} ${call.url} (${call.bodyLength} bytes)`);
            if (call.bodySnippet) console.log(`        ${call.bodySnippet.substring(0, 300)}`);
          }

          const cssFetchCalls = await page.evaluate('window.__fetchCalls || []').catch(() => []);
          console.log(`    Fetch calls: ${(cssFetchCalls as unknown[]).length}`);
          for (const call of cssFetchCalls as Array<{method: string; url: string; bodyLength: number; bodySnippet: string}>) {
            console.log(`      [FETCH] ${call.method} ${call.url} (${call.bodyLength} bytes)`);
            if (call.bodySnippet) console.log(`        ${call.bodySnippet.substring(0, 300)}`);
          }

          console.log('    CSS edit capture complete');
        } else {
          console.log('    WARNING: CSS editor not found. Taking screenshot for debugging...');
          const ssPath = join(process.cwd(), 'storage', 'screenshots', `css-debug-${Date.now()}.png`);
          await page.screenshot({ path: ssPath });
          console.log(`    Screenshot: ${ssPath}`);
        }
      }
    }

    captureAll = false; // Stop capturing everything

    // ── Analysis ─────────────────────────────────────────────────────
    console.log('\n' + '='.repeat(70));
    console.log('  RESULTS');
    console.log('='.repeat(70));

    // WebSocket summary
    console.log(`\n  WebSocket connections: ${wsConnections.length}`);
    if (wsConnections.length === 0) {
      console.log('  ✓ CONFIRMED: No WebSocket connections during editing');
      console.log('    (This matches our research — Squarespace uses REST, not WS)');
    } else {
      console.log('  ⚠ UNEXPECTED: WebSocket connections found!');
      for (const conn of wsConnections) {
        console.log(`    URL: ${conn.url}`);
        console.log(`    Frames sent: ${conn.framesSent.length}`);
        console.log(`    Frames received: ${conn.framesReceived.length}`);
      }
    }

    // HTTP summary
    const editPhaseCaptures = httpCaptures.slice(captureCountBeforeEdits);
    console.log(`\n  HTTP mutations captured (edit phases): ${editPhaseCaptures.length}`);

    if (editPhaseCaptures.length > 0) {
      console.log('\n  ' + '-'.repeat(60));
      console.log('  HTTP REQUESTS DURING EDITING');
      console.log('  ' + '-'.repeat(60));

      for (const req of editPhaseCaptures) {
        console.log(`\n  [${req.phase}] ${req.method} ${req.url}`);
        if (req.contentType) console.log(`    Content-Type: ${req.contentType}`);
        if (req.bodySize > 0) console.log(`    Body: ${req.bodySize} bytes`);
        if (req.bodySnippet) console.log(`    Body snippet: ${req.bodySnippet.substring(0, 500)}`);
        if (req.responseStatus) console.log(`    Response: ${req.responseStatus}`);
        if (req.responseBodySnippet) console.log(`    Response body: ${req.responseBodySnippet.substring(0, 500)}`);
      }
    } else {
      console.log('  ⚠ No HTTP mutations captured during editing.');
      console.log('    Possible reasons:');
      console.log('    - The save endpoint uses a path not caught by our filter');
      console.log('    - Save is triggered by a mechanism we did not capture');
      console.log('    - The autosave debounce was longer than our wait time');
    }

    // ── Save capture to JSON ─────────────────────────────────────────
    const dataDir = join(process.cwd(), 'data');
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outputPath = join(dataDir, `ws-capture-${timestamp}.json`);

    const output = {
      capturedAt: new Date().toISOString(),
      siteId,
      actionFilter,
      summary: {
        webSocketConnections: wsConnections.length,
        totalHTTPMutations: httpCaptures.length,
        editPhaseHTTPMutations: editPhaseCaptures.length,
        phases: [...new Set(httpCaptures.map(r => r.phase))],
      },
      webSocketConnections: wsConnections,
      editPhaseHTTPRequests: editPhaseCaptures,
      allHTTPRequests: httpCaptures,
    };

    await writeFile(outputPath, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`\n  Full capture saved: ${outputPath}`);

    // ── Save session ─────────────────────────────────────────────────
    if (context) {
      const authDir = join(process.cwd(), 'storage', 'auth');
      if (!existsSync(authDir)) mkdirSync(authDir, { recursive: true });
      await context.storageState({ path: SESSION_PATH });
    }

    console.log('\n' + '='.repeat(70));
    console.log('  DONE');
    console.log('='.repeat(70));

    if (!headless) {
      console.log('\n  Browser open for inspection. Ctrl+C to close.\n');
      await new Promise(() => {});
    } else {
      if (browser) await browser.close();
    }
  } catch (err) {
    console.error(`\n  Fatal error: ${errMsg(err)}\n`);
    logger.error({ error: errMsg(err) }, 'capture-websocket script failed');
    if (browser) await browser.close();
    process.exit(1);
  }
}

main();
