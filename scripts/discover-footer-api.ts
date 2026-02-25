/**
 * Footer API Discovery Script
 *
 * Opens the Squarespace editor with Playwright, intercepts all network requests,
 * navigates to footer edit mode, makes a small edit, saves (Cmd+S), and logs
 * every API call made during the process.
 *
 * Purpose: Discover the exact endpoints, payloads, and data format used by
 * Squarespace to read/write the footer. This information drives the footer
 * API implementation in content-save.ts.
 *
 * Usage: npx tsx scripts/discover-footer-api.ts
 *
 * Requires:
 * - Saved browser session at storage/auth/sqsp-session.json
 * - Playwright installed (npx playwright install chromium)
 */

import { chromium, type BrowserContext, type Request, type Response } from 'playwright';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// ── Config ──────────────────────────────────────────────────────────────────

const SESSION_PATH = join(process.cwd(), 'storage', 'auth', 'sqsp-session.json');
const SITE_SUBDOMAIN = 'grey-yellow-hbxc';
const SITE_URL = `https://${SITE_SUBDOMAIN}.squarespace.com`;

// ── Types ───────────────────────────────────────────────────────────────────

interface InterceptedCall {
  method: string;
  url: string;
  requestContentType?: string;
  requestBodyPreview?: string;
  responseStatus: number;
  responseContentType?: string;
  responseBodyPreview?: string;
  timestamp: number;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Check session exists
  if (!existsSync(SESSION_PATH)) {
    console.error('❌ Session file not found:', SESSION_PATH);
    console.error('Run the app and log in first to create a session.');
    process.exit(1);
  }

  const session = JSON.parse(readFileSync(SESSION_PATH, 'utf-8'));
  const cookies = session.cookies ?? [];

  console.log(`\n🔍 Footer API Discovery Script`);
  console.log(`   Site: ${SITE_URL}`);
  console.log(`   Session cookies: ${cookies.length}`);
  console.log('');

  // Launch browser
  const browser = await chromium.launch({ headless: false });
  const context: BrowserContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  });

  // Restore session cookies
  await context.addCookies(cookies);

  const page = await context.newPage();

  // ── Intercept all API calls ─────────────────────────────────────────────

  const interceptedCalls: InterceptedCall[] = [];

  page.on('request', (request: Request) => {
    const url = request.url();
    // Only log API calls (not static assets, images, etc.)
    if (url.includes('/api/') || url.includes('/format=json')) {
      const entry: InterceptedCall = {
        method: request.method(),
        url,
        requestContentType: request.headers()['content-type'],
        timestamp: Date.now(),
        responseStatus: 0,
      };

      // Try to capture request body
      const postData = request.postData();
      if (postData) {
        try {
          const parsed = JSON.parse(postData);
          entry.requestBodyPreview = JSON.stringify(parsed, null, 2).substring(0, 2000);
        } catch {
          entry.requestBodyPreview = postData.substring(0, 2000);
        }
      }

      interceptedCalls.push(entry);
    }
  });

  page.on('response', async (response: Response) => {
    const url = response.url();
    if (url.includes('/api/') || url.includes('/format=json')) {
      // Find matching request entry
      const entry = interceptedCalls.find(
        (e) => e.url === url && e.responseStatus === 0,
      );
      if (entry) {
        entry.responseStatus = response.status();
        entry.responseContentType = response.headers()['content-type'];

        try {
          const body = await response.text();
          try {
            const parsed = JSON.parse(body);
            entry.responseBodyPreview = JSON.stringify(parsed, null, 2).substring(0, 3000);
          } catch {
            entry.responseBodyPreview = body.substring(0, 3000);
          }
        } catch {
          entry.responseBodyPreview = '(could not read body)';
        }
      }
    }
  });

  // ── Step 1: Navigate to editor ──────────────────────────────────────────

  console.log('📄 Step 1: Navigating to editor...');
  await page.goto(`${SITE_URL}/config/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  console.log('   Current URL:', page.url());

  // ── Step 2: Try GET /api/site-header-footer directly ────────────────────

  console.log('\n📡 Step 2: Testing GET /api/site-header-footer...');
  const initialCallCount = interceptedCalls.length;

  try {
    // Make a direct fetch call to see what GET returns
    const getResult = await page.evaluate(async (siteUrl: string) => {
      try {
        const resp = await fetch(`${siteUrl}/api/site-header-footer`, {
          method: 'GET',
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        const body = await resp.text();
        return {
          status: resp.status,
          contentType: resp.headers.get('content-type'),
          body: body.substring(0, 5000),
        };
      } catch (err) {
        return { error: String(err) };
      }
    }, SITE_URL);

    console.log('   GET /api/site-header-footer result:');
    console.log('   Status:', (getResult as any).status);
    console.log('   Content-Type:', (getResult as any).contentType);
    if ((getResult as any).body) {
      try {
        const parsed = JSON.parse((getResult as any).body);
        console.log('   Body (parsed keys):', Object.keys(parsed));
        console.log('   Body preview:', JSON.stringify(parsed, null, 2).substring(0, 3000));
      } catch {
        console.log('   Body (raw):', (getResult as any).body?.substring(0, 1000));
      }
    }
    if ((getResult as any).error) {
      console.log('   Error:', (getResult as any).error);
    }
  } catch (err) {
    console.log('   Failed:', err);
  }

  // ── Step 3: Navigate to page and enter footer edit mode ─────────────────

  console.log('\n🦶 Step 3: Entering footer edit mode...');

  // Navigate to homepage editor
  await page.goto(`${SITE_URL}/config/pages/home`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  // Click EDIT to enter page editor
  const editButton = page.locator('button:has-text("EDIT")').first();
  if (await editButton.isVisible({ timeout: 5000 }).catch(() => false)) {
    await editButton.click();
    await page.waitForTimeout(2000);
  }

  // Scroll down to find and click "EDIT SITE FOOTER"
  const siteFrame = page.frame({ name: 'sqs-site-frame' });
  if (siteFrame) {
    await siteFrame.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);
  }

  // Look for footer edit button
  const footerButton = page.getByRole('button', { name: /edit site footer/i }).first();
  if (await footerButton.isVisible({ timeout: 5000 }).catch(() => false)) {
    console.log('   Found "EDIT SITE FOOTER" button — clicking...');
    await footerButton.click();
    await page.waitForTimeout(2000);
  } else {
    console.log('   Footer button not found via role — trying text selector...');
    const altButton = page.locator('text="EDIT SITE FOOTER"').first();
    if (await altButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await altButton.click();
      await page.waitForTimeout(2000);
    } else {
      console.log('   WARNING: Could not find footer edit button. Trying to scroll in main frame...');
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2000);
    }
  }

  // ── Step 4: Make a small edit and save ──────────────────────────────────

  console.log('\n💾 Step 4: Making edit and saving...');
  const preEditCallCount = interceptedCalls.length;

  // Try saving with Cmd+S to see what API calls are made
  await page.keyboard.press('Meta+s');
  await page.waitForTimeout(3000);

  // ── Step 5: Log all intercepted API calls ───────────────────────────────

  console.log('\n\n═══════════════════════════════════════════════════════════════');
  console.log('   INTERCEPTED API CALLS');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const call of interceptedCalls) {
    console.log(`\n────────────────────────────────────────────────────`);
    console.log(`${call.method} ${call.url}`);
    console.log(`Status: ${call.responseStatus}`);
    if (call.requestContentType) console.log(`Request Content-Type: ${call.requestContentType}`);
    if (call.requestBodyPreview) {
      console.log(`Request Body:`);
      console.log(call.requestBodyPreview);
    }
    if (call.responseContentType) console.log(`Response Content-Type: ${call.responseContentType}`);
    if (call.responseBodyPreview) {
      console.log(`Response Body:`);
      console.log(call.responseBodyPreview);
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────

  console.log('\n\n═══════════════════════════════════════════════════════════════');
  console.log('   SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════\n');
  console.log(`Total API calls intercepted: ${interceptedCalls.length}`);
  console.log(`Calls during footer edit/save: ${interceptedCalls.length - preEditCallCount}`);

  const footerCalls = interceptedCalls.filter(
    (c) =>
      c.url.includes('header-footer') ||
      c.url.includes('footer') ||
      c.url.includes('site-header'),
  );
  console.log(`Footer-related calls: ${footerCalls.length}`);
  for (const fc of footerCalls) {
    console.log(`  ${fc.method} ${fc.url} → ${fc.responseStatus}`);
  }

  // Close
  console.log('\n\nDone! Close the browser to exit.');
  await page.waitForTimeout(60_000); // Keep open for manual inspection
  await browser.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
