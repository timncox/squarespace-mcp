/**
 * Capture all Squarespace API traffic while Tim makes manual edits.
 * Opens a visible browser — just use the editor normally and close
 * the browser window when done. All API calls are saved to a JSON file.
 *
 * Usage: npx tsx scripts/capture-api-traffic.ts [site-id] [page-slug]
 *   e.g. npx tsx scripts/capture-api-traffic.ts grey-yellow-hbxc home
 */

import { chromium, type Request, type Response } from 'playwright';
import { writeFileSync, appendFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const STORAGE_DIR = 'storage/recordings';
const SESSION_PATH = resolve('storage', 'auth', 'sqsp-session.json');

interface ApiCall {
  timestamp: string;
  method: string;
  url: string;
  path: string;
  status?: number;
  requestBody?: unknown;
  responseBody?: unknown;
  requestHeaders?: Record<string, string>;
  durationMs?: number;
}

const apiCalls: ApiCall[] = [];

function isSquarespaceApi(url: string): boolean {
  return (
    url.includes('/api/') ||
    url.includes('media-api.squarespace.com') ||
    url.includes('/commerce/') ||
    url.includes('/collection/') ||
    url.includes('/member-areas/')
  );
}

async function main() {
  const siteId = process.argv[2] || 'grey-yellow-hbxc';
  const pageSlug = process.argv[3] || 'home';

  mkdirSync(STORAGE_DIR, { recursive: true });

  const outputFile = `${STORAGE_DIR}/api-traffic-${Date.now()}.json`;
  const liveLog = `${STORAGE_DIR}/api-traffic-live.log`;

  console.log(`\n🎬 API Traffic Capture`);
  console.log(`   Site: ${siteId}`);
  console.log(`   Page: ${pageSlug}`);
  console.log(`   Output: ${outputFile}`);
  console.log(`   Live log: ${liveLog}\n`);

  // Load session state
  if (!existsSync(SESSION_PATH)) {
    console.error('❌ No session file at', SESSION_PATH);
    process.exit(1);
  }
  const sessionState = JSON.parse(readFileSync(SESSION_PATH, 'utf-8'));

  // Clear live log
  writeFileSync(liveLog, '');

  // Launch visible browser
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: sessionState,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  // ── Intercept API calls ─────────────────────────────────────────────────
  const pendingRequests = new Map<string, { call: ApiCall; startTime: number }>();

  page.on('request', (request: Request) => {
    const url = request.url();
    if (!isSquarespaceApi(url)) return;

    const parsedUrl = new URL(url);
    const call: ApiCall = {
      timestamp: new Date().toISOString(),
      method: request.method(),
      url: url,
      path: parsedUrl.pathname + parsedUrl.search,
    };

    // Capture request body for POST/PUT/PATCH
    if (['PUT', 'POST', 'PATCH', 'DELETE'].includes(request.method())) {
      try {
        call.requestBody = request.postDataJSON();
      } catch {
        const postData = request.postData();
        if (postData) {
          call.requestBody = postData.substring(0, 10000);
        }
      }
    }

    // Capture key request headers
    const headers = request.headers();
    const interestingHeaders: Record<string, string> = {};
    for (const key of ['content-type', 'x-csrf-token', 'cookie']) {
      if (headers[key]) {
        interestingHeaders[key] = key === 'cookie'
          ? `[${headers[key].split(';').length} cookies]`
          : headers[key];
      }
    }
    if (Object.keys(interestingHeaders).length > 0) {
      call.requestHeaders = interestingHeaders;
    }

    const requestKey = `${request.method()}:${url}:${Date.now()}`;
    pendingRequests.set(requestKey, { call, startTime: Date.now() });

    // Store key on the request object for matching responses
    (request as any).__captureKey = requestKey;
  });

  page.on('response', async (response: Response) => {
    const request = response.request();
    const requestKey = (request as any).__captureKey;
    if (!requestKey) return;

    const pending = pendingRequests.get(requestKey);
    if (!pending) return;

    pending.call.status = response.status();
    pending.call.durationMs = Date.now() - pending.startTime;

    // Capture response body for successful requests
    if (response.status() < 500) {
      try {
        const body = await response.json();
        // Truncate large responses but keep structure
        const bodyStr = JSON.stringify(body);
        if (bodyStr.length > 50000) {
          pending.call.responseBody = {
            _truncated: true,
            _originalSize: bodyStr.length,
            _preview: JSON.parse(bodyStr.substring(0, 50000) + '"}'),
          };
        } else {
          pending.call.responseBody = body;
        }
      } catch {
        // Not JSON — try text
        try {
          const text = await response.text();
          if (text.length > 0 && text.length < 5000) {
            pending.call.responseBody = { _text: text };
          }
        } catch {
          // Can't read body
        }
      }
    }

    apiCalls.push(pending.call);
    pendingRequests.delete(requestKey);

    // Live console log
    const emoji = response.status() < 400 ? '✅' : '❌';
    const bodyInfo = pending.call.requestBody ? ' [body]' : '';
    const line = `${emoji} ${pending.call.method} ${pending.call.path} → ${response.status()} (${pending.call.durationMs}ms)${bodyInfo}`;
    console.log(`  ${line}`);

    // Append to live log file
    appendFileSync(liveLog, `${pending.call.timestamp} ${line}\n`);
  });

  // ── Navigate ──────────────────────────────────────────────────────────
  const siteUrl = `https://${siteId}.squarespace.com/${pageSlug}`;
  console.log(`🌐 Opening ${siteUrl}...\n`);
  await page.goto(siteUrl, { waitUntil: 'networkidle', timeout: 30000 });

  console.log('='.repeat(60));
  console.log('📡 CAPTURING API TRAFFIC');
  console.log('='.repeat(60));
  console.log('\nMake your changes in the browser.');
  console.log('Close the browser window when done.\n');

  // ── Wait for browser to close ─────────────────────────────────────────
  await new Promise<void>((resolve) => {
    browser.on('disconnected', () => resolve());
    // Also handle all pages closing
    context.on('close', () => resolve());
  });

  // ── Save results ──────────────────────────────────────────────────────
  const recording = {
    siteId,
    pageSlug,
    capturedAt: new Date().toISOString(),
    totalCalls: apiCalls.length,
    summary: {
      gets: apiCalls.filter(c => c.method === 'GET').length,
      puts: apiCalls.filter(c => c.method === 'PUT').length,
      posts: apiCalls.filter(c => c.method === 'POST').length,
      deletes: apiCalls.filter(c => c.method === 'DELETE').length,
    },
    apiCalls,
  };

  writeFileSync(outputFile, JSON.stringify(recording, null, 2));

  console.log(`\n💾 Saved ${apiCalls.length} API calls to ${outputFile}`);
  console.log(`   GETs: ${recording.summary.gets}`);
  console.log(`   PUTs: ${recording.summary.puts}`);
  console.log(`   POSTs: ${recording.summary.posts}`);
  console.log(`   DELETEs: ${recording.summary.deletes}`);

  // Show the most interesting calls
  const writes = apiCalls.filter(c => ['PUT', 'POST', 'PATCH', 'DELETE'].includes(c.method));
  if (writes.length > 0) {
    console.log(`\n📝 Write operations:`);
    for (const call of writes) {
      console.log(`   ${call.method} ${call.path} → ${call.status}`);
    }
  }

  console.log('\n✅ Done!');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
