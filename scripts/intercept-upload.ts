/**
 * Upload Network Interception Script
 *
 * Uses `page.route('**\/*')` to intercept ALL network traffic at the Chromium
 * network layer. This captures browser-native file uploads triggered by
 * `setInputFiles()` on `<input type="file">`, which `page.on('request')` misses.
 *
 * Goal: Find the exact URL where Squarespace sends the image bytes after
 * a file is selected via a file input element.
 *
 * Usage:
 *   npx tsx scripts/intercept-upload.ts
 *   npx tsx scripts/intercept-upload.ts --site grey-yellow-hbxc
 *   npx tsx scripts/intercept-upload.ts --headless
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { chromium, Page, Route, Request, Response, Browser, BrowserContext } from 'playwright';
import { join } from 'path';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { resolveSite, navigateToSite, navigateToPage, enterEditMode } from '../src/automation/site-navigator.js';
import { discoverSites } from '../src/automation/site-discovery.js';
import { logger } from '../src/utils/logger.js';
import { errMsg } from '../src/utils/errors.js';

const SESSION_PATH = join(process.cwd(), 'storage', 'auth', 'sqsp-session.json');

// ── Types ─────────────────────────────────────────────────────────────────

interface InterceptedRequest {
  timestamp: string;
  method: string;
  url: string;
  contentType: string;
  bodySize: number;
  headers: Record<string, string>;
  resourceType: string;
  /** True if this looks like an upload (multipart, octet-stream, large body, etc.) */
  isUploadCandidate: boolean;
  /** True if this request goes to a domain other than the site's squarespace subdomain */
  isExternalDomain: boolean;
  /** The target domain */
  domain: string;
  /** Response status, if captured */
  responseStatus?: number;
  /** Response body snippet (first 2000 chars), if captured */
  responseBodySnippet?: string;
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

// ── Test Image Generation ─────────────────────────────────────────────────

/**
 * Create a valid 10x10 red PNG in storage/uploads/ for testing.
 * Returns the absolute path to the created file.
 */
function createTestImage(): string {
  const uploadDir = join(process.cwd(), 'storage', 'uploads');
  if (!existsSync(uploadDir)) {
    mkdirSync(uploadDir, { recursive: true });
  }

  const testImgPath = join(uploadDir, 'intercept-test.png');

  // Minimal valid 1x1 PNG (red pixel, 8-bit RGB)
  const PNG_BYTES = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // 8-bit RGB
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, // IDAT chunk
    0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, // compressed data
    0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, // ...
    0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, // IEND chunk
    0x44, 0xae, 0x42, 0x60, 0x82,
  ]);

  writeFileSync(testImgPath, PNG_BYTES);
  console.log(`  Created test image: ${testImgPath} (${PNG_BYTES.length} bytes)`);
  return testImgPath;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const siteId = flags.site ?? 'grey-yellow-hbxc';
  const headless = flags.headless === 'true';

  console.log('\n' + '='.repeat(70));
  console.log('  UPLOAD NETWORK INTERCEPTION');
  console.log('  Using page.route() for true network-level capture');
  console.log('='.repeat(70));
  console.log(`  Site: ${siteId}`);
  console.log(`  Headless: ${headless}`);
  console.log('');

  // We create our OWN browser context with serviceWorkers: 'block'.
  // This forces all requests (including uploads) through the main HTTP stack
  // where page.route() and page.on('request') can see them.
  // The researcher found that Squarespace's editor uses a Service Worker that
  // intercepts upload requests, making them invisible to Playwright's standard hooks.
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  const allIntercepted: InterceptedRequest[] = [];
  let requestCounter = 0;

  try {
    // ── Setup: Launch browser with serviceWorkers: 'block' ──────────
    console.log('  [1/8] Launching browser with serviceWorkers BLOCKED...');
    browser = await chromium.launch({
      headless,
      slowMo: 100,
    });

    // Load saved session but block service workers
    const contextOptions: Record<string, unknown> = {
      serviceWorkers: 'block' as const,
    };
    if (existsSync(SESSION_PATH)) {
      console.log('    Loading saved session state');
      contextOptions.storageState = SESSION_PATH;
    }
    context = await browser.newContext(contextOptions);
    page = await context.newPage();
    console.log('    Service workers BLOCKED — all traffic goes through main HTTP stack');

    // We still need to verify login — navigate to squarespace admin
    console.log('    Verifying login state...');
    await page.goto('https://account.squarespace.com/project-picker', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    // Check if we're logged in by looking at the URL
    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/signin')) {
      console.log('    WARNING: Not logged in. Please run a normal session first to save login cookies.');
      console.log('    Try: npx tsx scripts/test-login.ts');
      process.exit(1);
    }
    console.log('    Login verified ✓');

    console.log('  [2/8] Discovering sites...');
    await discoverSites(page);
    const client = await resolveSite(siteId, page);
    console.log(`  Resolved: ${client.name} (${client.site.adminUrl})`);

    console.log('  [3/8] Navigating to site and home page...');
    await navigateToSite(page, client);
    await navigateToPage(page, client, 'home');

    console.log('  [4/8] Entering edit mode...');
    await enterEditMode(page);
    await page.waitForTimeout(2000);

    // ── Setup: Network Interception ────────────────────────────────────
    // This is the KEY difference from the old script: page.route() intercepts
    // at the Chromium network stack level, BEFORE the request leaves the browser.
    // It catches everything including browser-native file uploads that
    // page.on('request') misses.

    console.log('  [5/8] Setting up network interception (page.route + event listeners)...\n');

    const siteDomain = `${siteId}.squarespace.com`;

    // ── Layer 1: page.route('**/*') — the nuclear option ───────────────
    // Intercepts EVERY request including native form uploads.
    await page.route('**/*', async (route: Route) => {
      requestCounter++;
      const request = route.request();
      const url = request.url();
      const method = request.method();
      const headers = request.headers();
      const contentType = headers['content-type'] || '';
      const resourceType = request.resourceType();

      // Get body size — for route interception, use postDataBuffer()
      let bodySize = 0;
      try {
        const bodyBuffer = request.postDataBuffer();
        if (bodyBuffer) {
          bodySize = bodyBuffer.length;
        }
      } catch {
        // postDataBuffer may not be available for all requests
      }

      // Determine if this is an upload candidate
      const isUploadCandidate =
        contentType.includes('multipart') ||
        contentType.includes('form-data') ||
        contentType.includes('octet-stream') ||
        bodySize > 1000 ||
        url.includes('upload') ||
        url.includes('media-api') ||
        url.includes('/asset') ||
        url.includes('tus') ||
        url.includes('alexandria');

      // Determine domain
      let domain = '';
      try {
        domain = new URL(url).hostname;
      } catch {
        domain = 'unknown';
      }
      const isExternalDomain = !domain.includes(siteId) && !domain.includes('squarespace.com');

      const entry: InterceptedRequest = {
        timestamp: new Date().toISOString(),
        method,
        url,
        contentType,
        bodySize,
        headers,
        resourceType,
        isUploadCandidate,
        isExternalDomain,
        domain,
      };

      // Log EVERYTHING with clear markers for upload candidates
      const prefix = isUploadCandidate ? '>>> UPLOAD?' : '          ';
      const domainTag = isExternalDomain ? ` [EXTERNAL: ${domain}]` : '';

      // Always log POST/PUT/PATCH/DELETE and upload candidates
      if (method !== 'GET' || isUploadCandidate) {
        console.log(`${prefix} [route #${requestCounter}] ${method} ${url.substring(0, 150)}${domainTag}`);
        if (contentType) console.log(`             Content-Type: ${contentType}`);
        if (bodySize > 0) console.log(`             Body size: ${bodySize} bytes`);
      }

      // Highlight with big banner for likely uploads
      if (isUploadCandidate && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        console.log('');
        console.log('  ************************************************************');
        console.log(`  *** LIKELY UPLOAD: ${method} ${url.substring(0, 100)}`);
        console.log(`  *** Content-Type: ${contentType}`);
        console.log(`  *** Body size: ${bodySize} bytes`);
        console.log(`  *** Resource type: ${resourceType}`);
        console.log(`  *** Domain: ${domain}`);
        // Log all headers for upload candidates
        console.log('  *** Headers:');
        for (const [k, v] of Object.entries(headers)) {
          console.log(`  ***   ${k}: ${v.substring(0, 200)}`);
        }
        console.log('  ************************************************************');
        console.log('');
      }

      allIntercepted.push(entry);

      // IMPORTANT: Continue the request so it actually goes through
      await route.continue();
    });

    // ── Layer 2: page.on('request') — standard event listener ──────────
    // This may not catch native uploads, but captures everything else.
    // We use it to cross-reference with route captures.
    page.on('request', (request: Request) => {
      const url = request.url();
      const method = request.method();
      if (method !== 'GET') {
        console.log(`  [event:request] ${method} ${url.substring(0, 120)}`);
      }
    });

    // ── Layer 3: page.on('response') — captures responses ─────────────
    page.on('response', async (response: Response) => {
      const request = response.request();
      const url = request.url();
      const method = request.method();
      const status = response.status();

      // Update the matching intercepted entry with response data
      const match = [...allIntercepted].reverse().find(
        (e: InterceptedRequest) => e.url === url && e.method === method && !e.responseStatus,
      );
      if (match) {
        match.responseStatus = status;
        try {
          const body = await response.text().catch(() => '');
          if (body.length > 0 && body.length < 5000) {
            match.responseBodySnippet = body.substring(0, 2000);
          } else if (body.length >= 5000) {
            match.responseBodySnippet = `[${body.length} bytes — truncated] ${body.substring(0, 500)}`;
          }
        } catch { /* response body not always available */ }
      }

      // Log non-GET responses
      if (method !== 'GET') {
        console.log(`  [event:response] ${status} ${method} ${url.substring(0, 120)}`);
      }
    });

    // Give the interception a moment to settle
    await page.waitForTimeout(1000);
    console.log('\n  Network interception active. Starting editor interactions...\n');

    // ── Editor interactions: add an Image block and upload ──────────────

    console.log('  [6/8] Clicking section and entering edit mode...');

    // Click first section in the iframe to select it
    const siteFrame = page.frameLocator('#sqs-site-frame');
    const firstSection = siteFrame.locator('.page-section, section[data-section-id]').first();
    if (await firstSection.isVisible({ timeout: 5000 }).catch(() => false)) {
      const sBox = await firstSection.boundingBox();
      if (sBox) {
        await page.mouse.click(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
        console.log('    Clicked first section');
        await page.waitForTimeout(1500);
      }
    } else {
      console.log('    WARNING: No sections found in iframe');
    }

    // Click "Edit Content" to enter Fluid Engine edit mode
    const editContentBtn = page.locator(
      'button:has-text("Edit Content"), button:has-text("EDIT CONTENT"), [aria-label="Edit Content"]',
    ).first();
    if (await editContentBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editContentBtn.click();
      console.log('    Entered section edit mode');
      await page.waitForTimeout(2000);
    } else {
      console.log('    Edit Content button not found — may already be in edit mode');
    }

    console.log('  [7/8] Adding Image block via block picker...');

    // Click ADD BLOCK
    const addBlockBtn = page.getByRole('button', { name: /add block/i }).first();
    if (await addBlockBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await addBlockBtn.click();
      console.log('    Clicked ADD BLOCK');
      await page.waitForTimeout(2000);

      // Click "Image" in the block picker (inside iframe)
      const frame = page.frame({ name: 'sqs-site-frame' });
      if (frame) {
        const clicked = await frame.evaluate(() => {
          const allElements = document.querySelectorAll('*');
          for (const el of allElements) {
            const htmlEl = el as HTMLElement;
            const text = htmlEl.innerText?.trim();
            if (text === 'Image' && el.children.length <= 3) {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                htmlEl.click();
                return true;
              }
            }
          }
          return false;
        }).catch(() => false);

        if (clicked) {
          console.log('    Clicked Image in block picker');
          await page.waitForTimeout(3000);
        } else {
          console.log('    WARNING: Could not find "Image" in block picker');
        }
      }
    } else {
      console.log('    WARNING: ADD BLOCK button not visible');
    }

    // Double-click the new empty image block to open the image editor
    console.log('    Looking for empty image block to open editor...');
    const emptyImgBlock = siteFrame.locator('.sqs-block-image').last();
    const imgBox = await emptyImgBlock.boundingBox().catch(() => null);
    if (imgBox) {
      await page.mouse.dblclick(imgBox.x + imgBox.width / 2, imgBox.y + imgBox.height / 2);
      console.log('    Double-clicked empty image block');
      await page.waitForTimeout(2000);
    } else {
      console.log('    WARNING: No image block found to double-click');
    }

    // ── Upload the test image ─────────────────────────────────────────
    console.log('\n  [8/8] Uploading test image via setInputFiles()...\n');
    console.log('  vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv');
    console.log('  vv  UPLOAD START — watching for network traffic below  vv');
    console.log('  vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv\n');

    const testImgPath = createTestImage();
    let uploaded = false;

    // Count requests before upload to isolate upload-related traffic
    const requestCountBefore = allIntercepted.length;

    // Try iframe file inputs first
    const iframeFrame = page.frame({ name: 'sqs-site-frame' });
    if (iframeFrame) {
      const iframeInputs = iframeFrame.locator('input[type="file"]');
      const iCount = await iframeInputs.count();
      console.log(`  File inputs in iframe: ${iCount}`);
      for (let i = 0; i < iCount; i++) {
        try {
          const accept = await iframeInputs.nth(i).getAttribute('accept');
          console.log(`    iframe input #${i}: accept="${accept}"`);
          await iframeInputs.nth(i).setInputFiles(testImgPath);
          uploaded = true;
          console.log(`    >>> Uploaded via iframe file input #${i}`);
          break;
        } catch (err) {
          console.log(`    iframe input #${i} failed: ${errMsg(err)}`);
        }
      }
    }

    // Try main frame file inputs
    if (!uploaded) {
      const mainInputs = page.locator('input[type="file"]');
      const mCount = await mainInputs.count();
      console.log(`  File inputs in main frame: ${mCount}`);
      for (let i = 0; i < mCount; i++) {
        try {
          const accept = await mainInputs.nth(i).getAttribute('accept');
          console.log(`    main input #${i}: accept="${accept}"`);
          await mainInputs.nth(i).setInputFiles(testImgPath);
          uploaded = true;
          console.log(`    >>> Uploaded via main file input #${i}`);
          break;
        } catch (err) {
          console.log(`    main input #${i} failed: ${errMsg(err)}`);
        }
      }
    }

    if (uploaded) {
      console.log('\n  Waiting 15 seconds to capture all upload-related traffic...\n');
      await page.waitForTimeout(15000);
    } else {
      console.log('\n  WARNING: No file input found. Checking for upload buttons...');

      // List available buttons for debugging
      const buttons = await page.locator('button').allInnerTexts();
      const visibleButtons = buttons.filter((t) => t.trim()).map((t) => t.trim());
      console.log(`  Visible buttons (${visibleButtons.length}):`);
      for (const text of visibleButtons.slice(0, 30)) {
        console.log(`    "${text}"`);
      }

      console.log('\n  Waiting 5 seconds for any background traffic...');
      await page.waitForTimeout(5000);
    }

    console.log('\n  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^');
    console.log('  ^^  UPLOAD END — analyzing captured traffic           ^^');
    console.log('  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^\n');

    // ── Analysis ──────────────────────────────────────────────────────

    // Requests that appeared AFTER the upload
    const uploadPhaseRequests = allIntercepted.slice(requestCountBefore);

    console.log('='.repeat(70));
    console.log('  RESULTS');
    console.log('='.repeat(70));

    console.log(`\n  Total requests intercepted (route): ${allIntercepted.length}`);
    console.log(`  Requests during upload phase: ${uploadPhaseRequests.length}`);

    // ── Upload candidates ─────────────────────────────────────────────
    const uploadCandidates = allIntercepted.filter((r) => r.isUploadCandidate);
    console.log(`\n  Upload candidates (all phases): ${uploadCandidates.length}`);
    if (uploadCandidates.length > 0) {
      console.log('\n' + '-'.repeat(70));
      console.log('  UPLOAD CANDIDATES (multipart, octet-stream, large body, upload URLs)');
      console.log('-'.repeat(70));
      for (const req of uploadCandidates) {
        console.log(`\n  ${req.method} ${req.url}`);
        console.log(`    Content-Type: ${req.contentType || '(none)'}`);
        console.log(`    Body size: ${req.bodySize} bytes`);
        console.log(`    Resource type: ${req.resourceType}`);
        console.log(`    Domain: ${req.domain}`);
        if (req.responseStatus) {
          console.log(`    Response: ${req.responseStatus}`);
        }
        if (req.responseBodySnippet) {
          console.log(`    Response body: ${req.responseBodySnippet.substring(0, 300)}`);
        }
      }
    }

    // ── External domain requests ──────────────────────────────────────
    const externalRequests = allIntercepted.filter((r) => r.isExternalDomain);
    const uniqueExternalDomains = [...new Set(externalRequests.map((r) => r.domain))];
    console.log(`\n  External domain requests: ${externalRequests.length} across ${uniqueExternalDomains.length} domains`);
    if (uniqueExternalDomains.length > 0) {
      console.log('\n' + '-'.repeat(70));
      console.log('  EXTERNAL DOMAINS (requests outside squarespace.com)');
      console.log('-'.repeat(70));
      for (const domain of uniqueExternalDomains) {
        const domainReqs = externalRequests.filter((r) => r.domain === domain);
        const methods = [...new Set(domainReqs.map((r) => r.method))];
        console.log(`\n  ${domain} (${domainReqs.length} requests, methods: ${methods.join(', ')})`);
        for (const req of domainReqs.slice(0, 10)) {
          console.log(`    ${req.method} ${req.url.substring(0, 150)}`);
          if (req.contentType) console.log(`      Content-Type: ${req.contentType}`);
          if (req.bodySize > 0) console.log(`      Body: ${req.bodySize} bytes`);
        }
        if (domainReqs.length > 10) {
          console.log(`    ... and ${domainReqs.length - 10} more`);
        }
      }
    }

    // ── All non-GET requests during upload phase ──────────────────────
    const nonGetUploadPhase = uploadPhaseRequests.filter((r) => r.method !== 'GET');
    console.log(`\n  Non-GET requests during upload phase: ${nonGetUploadPhase.length}`);
    if (nonGetUploadPhase.length > 0) {
      console.log('\n' + '-'.repeat(70));
      console.log('  ALL NON-GET REQUESTS DURING UPLOAD PHASE');
      console.log('-'.repeat(70));
      for (const req of nonGetUploadPhase) {
        console.log(`\n  ${req.method} ${req.url}`);
        console.log(`    Content-Type: ${req.contentType || '(none)'}`);
        console.log(`    Body size: ${req.bodySize} bytes`);
        console.log(`    Domain: ${req.domain}`);
        if (req.responseStatus) {
          console.log(`    Response: ${req.responseStatus}`);
        }
        if (req.responseBodySnippet) {
          console.log(`    Response body: ${req.responseBodySnippet.substring(0, 500)}`);
        }
      }
    }

    // ── All POST requests (any phase) ─────────────────────────────────
    const allPosts = allIntercepted.filter((r) => r.method === 'POST' || r.method === 'PUT' || r.method === 'PATCH');
    console.log(`\n  All POST/PUT/PATCH requests: ${allPosts.length}`);
    if (allPosts.length > 0) {
      console.log('\n' + '-'.repeat(70));
      console.log('  ALL POST/PUT/PATCH REQUESTS');
      console.log('-'.repeat(70));
      for (const req of allPosts) {
        const marker = req.isUploadCandidate ? ' *** UPLOAD CANDIDATE ***' : '';
        console.log(`  ${req.method} ${req.url.substring(0, 150)}${marker}`);
        if (req.contentType) console.log(`    CT: ${req.contentType}`);
        if (req.bodySize > 0) console.log(`    Body: ${req.bodySize} bytes`);
        if (req.responseStatus) console.log(`    Status: ${req.responseStatus}`);
      }
    }

    // ── Save full capture to JSON ─────────────────────────────────────
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outputPath = join(process.cwd(), 'data', `intercept-upload-${timestamp}.json`);

    // Ensure data directory exists
    const dataDir = join(process.cwd(), 'data');
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    const output = {
      capturedAt: new Date().toISOString(),
      siteId,
      uploaded,
      summary: {
        totalIntercepted: allIntercepted.length,
        uploadPhaseRequests: uploadPhaseRequests.length,
        uploadCandidates: uploadCandidates.length,
        externalDomains: uniqueExternalDomains,
        nonGetDuringUpload: nonGetUploadPhase.length,
        allPostPutPatch: allPosts.length,
      },
      uploadCandidates: uploadCandidates.map((r) => ({
        method: r.method,
        url: r.url,
        contentType: r.contentType,
        bodySize: r.bodySize,
        domain: r.domain,
        resourceType: r.resourceType,
        responseStatus: r.responseStatus,
        responseBodySnippet: r.responseBodySnippet,
      })),
      uploadPhaseNonGet: nonGetUploadPhase.map((r) => ({
        method: r.method,
        url: r.url,
        contentType: r.contentType,
        bodySize: r.bodySize,
        domain: r.domain,
        responseStatus: r.responseStatus,
        responseBodySnippet: r.responseBodySnippet,
      })),
      allRequests: allIntercepted.map((r) => ({
        timestamp: r.timestamp,
        method: r.method,
        url: r.url,
        contentType: r.contentType,
        bodySize: r.bodySize,
        domain: r.domain,
        resourceType: r.resourceType,
        isUploadCandidate: r.isUploadCandidate,
        isExternalDomain: r.isExternalDomain,
        responseStatus: r.responseStatus,
      })),
    };

    await writeFile(outputPath, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`\n  Full capture saved to: ${outputPath}`);

    console.log('\n' + '='.repeat(70));
    console.log('  DONE');
    console.log('='.repeat(70));

    // ── Cleanup ───────────────────────────────────────────────────────
    // Save session state for future runs
    if (context) {
      const authDir = join(process.cwd(), 'storage', 'auth');
      if (!existsSync(authDir)) mkdirSync(authDir, { recursive: true });
      await context.storageState({ path: SESSION_PATH });
      console.log('  Session state saved.');
    }

    if (!headless) {
      console.log('\n  Browser still open for inspection. Press Ctrl+C to close.\n');
      await new Promise(() => {}); // Keep alive
    } else {
      if (browser) await browser.close();
    }
  } catch (err) {
    console.error(`\n  Fatal error: ${errMsg(err)}\n`);
    logger.error({ error: errMsg(err) }, 'intercept-upload script failed');
    if (browser) await browser.close();
    process.exit(1);
  }
}

main();
