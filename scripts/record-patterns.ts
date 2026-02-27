/**
 * Record Squarespace editor patterns by watching API calls while
 * Tim makes manual changes. Captures before/after snapshots and
 * logs all Content Save API traffic.
 *
 * Usage: npx tsx scripts/record-patterns.ts [site-id] [page-slug]
 *   e.g. npx tsx scripts/record-patterns.ts tim-cox home
 */

import { chromium, type Page, type Request, type Response } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { createInterface } from 'readline';

const STORAGE_DIR = 'storage/recordings';
const SESSION_PATH = resolve('storage', 'auth', 'sqsp-session.json');

interface ApiCall {
  timestamp: string;
  method: string;
  url: string;
  status?: number;
  requestBody?: unknown;
  responseBody?: unknown;
  durationMs?: number;
}

const apiCalls: ApiCall[] = [];
let snapshotBefore: unknown = null;
let snapshotAfter: unknown = null;

// ── Readline for interactive prompts ────────────────────────────────────────

const rl = createInterface({ input: process.stdin, output: process.stdout });
function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const siteId = process.argv[2] || 'tim-cox';
  const pageSlug = process.argv[3] || 'home';

  mkdirSync(STORAGE_DIR, { recursive: true });

  console.log(`\n🎬 Recording Squarespace patterns`);
  console.log(`   Site: ${siteId}`);
  console.log(`   Page: ${pageSlug}\n`);

  // Load session state
  if (!existsSync(SESSION_PATH)) {
    console.error('❌ No session file at', SESSION_PATH);
    process.exit(1);
  }

  const sessionState = JSON.parse(
    (await import('fs')).readFileSync(SESSION_PATH, 'utf-8'),
  );

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
    // Capture Squarespace API calls
    if (
      url.includes('/api/page-sections/') ||
      url.includes('/api/site-header-footer') ||
      url.includes('/api/content/') ||
      url.includes('/api/pages/') ||
      url.includes('media-api.squarespace.com')
    ) {
      const call: ApiCall = {
        timestamp: new Date().toISOString(),
        method: request.method(),
        url: url,
      };

      // Capture request body for POST/PUT
      if (request.method() === 'PUT' || request.method() === 'POST') {
        try {
          call.requestBody = request.postDataJSON();
        } catch {
          call.requestBody = request.postData()?.substring(0, 2000);
        }
      }

      pendingRequests.set(url + ':' + request.method(), {
        call,
        startTime: Date.now(),
      });
    }
  });

  page.on('response', async (response: Response) => {
    const url = response.url();
    const method = response.request().method();
    const key = url + ':' + method;
    const pending = pendingRequests.get(key);

    if (pending) {
      pending.call.status = response.status();
      pending.call.durationMs = Date.now() - pending.startTime;

      // Capture response body for GET (section data)
      if (method === 'GET' && response.status() === 200) {
        try {
          pending.call.responseBody = await response.json();
        } catch {
          // Not JSON
        }
      }

      apiCalls.push(pending.call);
      pendingRequests.delete(key);

      // Log in real time
      const emoji = response.status() < 400 ? '✅' : '❌';
      console.log(
        `  ${emoji} ${method} ${url.replace(/https:\/\/[^/]+/, '')} → ${response.status()} (${pending.call.durationMs}ms)`,
      );
    }
  });

  // ── Navigate to site ────────────────────────────────────────────────────
  const siteUrl = `https://${siteId}.squarespace.com/${pageSlug}`;
  console.log(`🌐 Navigating to ${siteUrl}...`);
  await page.goto(siteUrl, { waitUntil: 'networkidle', timeout: 30000 });

  // Take before screenshot
  await page.screenshot({
    path: `${STORAGE_DIR}/before.png`,
    fullPage: true,
  });
  console.log('📸 Before screenshot saved\n');

  // ── Capture "before" snapshot via API ───────────────────────────────────
  console.log('📋 Capturing before snapshot via Content Save API...');
  try {
    const { createContentSaveClient } = await import('../src/services/content-save.js');
    const client = createContentSaveClient(siteId);

    // Get pageSectionsId from the page DOM
    const pageSectionsId = await page.evaluate(() => {
      const el = document.querySelector('[data-page-sections]');
      return el?.getAttribute('data-page-sections') || null;
    });

    // Try iframe too
    const iframePSId = await page.evaluate(() => {
      const iframe = document.querySelector('#sqs-site-frame') as HTMLIFrameElement;
      if (!iframe?.contentDocument) return null;
      const el = iframe.contentDocument.querySelector('[data-page-sections]');
      return el?.getAttribute('data-page-sections') || null;
    }).catch(() => null);

    const psId = pageSectionsId || iframePSId;
    if (psId) {
      const sections = await client.getPageSections(psId);
      snapshotBefore = sections;
      console.log(`   Found ${sections.sections.length} sections (pageSectionsId: ${psId})`);
    } else {
      console.log('   ⚠️ Could not find pageSectionsId — will use API call logs instead');
    }
  } catch (err) {
    console.log(`   ⚠️ Snapshot failed: ${err instanceof Error ? err.message : err}`);
  }

  // ── Enter edit mode ─────────────────────────────────────────────────────
  console.log('\n🔧 Entering edit mode...');
  try {
    const editBtn = page.locator('button:has-text("Edit")').first();
    const visible = await editBtn.isVisible({ timeout: 5000 }).catch(() => false);
    if (visible) {
      await editBtn.click();
      await page.waitForTimeout(3000);
      console.log('   ✅ Edit mode entered');
    } else {
      console.log('   ℹ️  No Edit button found — may need manual navigation');
    }
  } catch {
    console.log('   ℹ️  Could not auto-enter edit mode');
  }

  // ── Interactive session ─────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60));
  console.log('🎯 RECORDING SESSION ACTIVE');
  console.log('='.repeat(60));
  console.log('\nMake your changes in the browser window.');
  console.log('All Squarespace API calls are being recorded.\n');
  console.log('Commands:');
  console.log('  [Enter]     — Take a snapshot of current state');
  console.log('  "note xyz"  — Add a note to the recording');
  console.log('  "screenshot" — Take a screenshot');
  console.log('  "done"      — Finish recording and save results');
  console.log('  "calls"     — Show captured API calls so far');
  console.log('');

  const notes: Array<{ timestamp: string; note: string }> = [];
  const screenshots: string[] = [];

  while (true) {
    const input = await ask('> ');
    const trimmed = input.trim().toLowerCase();

    if (trimmed === 'done' || trimmed === 'q' || trimmed === 'quit') {
      break;
    }

    if (trimmed === '' || trimmed === 'snap' || trimmed === 'snapshot') {
      // Take interim snapshot
      try {
        const { createContentSaveClient } = await import('../src/services/content-save.js');
        const client = createContentSaveClient(siteId);

        // Try to get pageSectionsId from iframe
        const psId = await page.evaluate(() => {
          const iframe = document.querySelector('#sqs-site-frame') as HTMLIFrameElement;
          if (iframe?.contentDocument) {
            const el = iframe.contentDocument.querySelector('[data-page-sections]');
            if (el) return el.getAttribute('data-page-sections');
          }
          const el = document.querySelector('[data-page-sections]');
          return el?.getAttribute('data-page-sections') || null;
        }).catch(() => null);

        if (psId) {
          const sections = await client.getPageSections(psId);
          snapshotAfter = sections;
          console.log(`📋 Snapshot: ${sections.sections.length} sections`);
          for (let i = 0; i < sections.sections.length; i++) {
            const s = sections.sections[i];
            const blockCount = s.fluidEngineContext?.gridContents?.length ?? 0;
            const id = s.id?.substring(0, 8) ?? '?';
            console.log(`   Section ${i}: ${blockCount} blocks (${id}...)`);
          }
        } else {
          console.log('⚠️ Could not find pageSectionsId');
        }
      } catch (err) {
        console.log(`⚠️ Snapshot failed: ${err instanceof Error ? err.message : err}`);
      }
      continue;
    }

    if (trimmed.startsWith('note ')) {
      const note = input.trim().substring(5);
      notes.push({ timestamp: new Date().toISOString(), note });
      console.log(`📝 Note added: "${note}"`);
      continue;
    }

    if (trimmed === 'screenshot' || trimmed === 'ss') {
      const ssPath = `${STORAGE_DIR}/screenshot-${Date.now()}.png`;
      await page.screenshot({ path: ssPath, fullPage: true });
      screenshots.push(ssPath);
      console.log(`📸 Screenshot saved: ${ssPath}`);
      continue;
    }

    if (trimmed === 'calls') {
      if (apiCalls.length === 0) {
        console.log('No API calls captured yet.');
      } else {
        console.log(`\n📡 ${apiCalls.length} API calls captured:`);
        for (const call of apiCalls) {
          const path = call.url.replace(/https:\/\/[^/]+/, '');
          const hasBody = call.requestBody ? ' [body]' : '';
          console.log(`  ${call.method} ${path} → ${call.status ?? '?'} (${call.durationMs ?? '?'}ms)${hasBody}`);
        }
        console.log('');
      }
      continue;
    }

    console.log('Unknown command. Type "done" to finish, or press Enter to take a snapshot.');
  }

  // ── Capture "after" snapshot ────────────────────────────────────────────
  console.log('\n📋 Capturing final snapshot...');
  try {
    const { createContentSaveClient } = await import('../src/services/content-save.js');
    const client = createContentSaveClient(siteId);

    const psId = await page.evaluate(() => {
      const iframe = document.querySelector('#sqs-site-frame') as HTMLIFrameElement;
      if (iframe?.contentDocument) {
        const el = iframe.contentDocument.querySelector('[data-page-sections]');
        if (el) return el.getAttribute('data-page-sections');
      }
      const el = document.querySelector('[data-page-sections]');
      return el?.getAttribute('data-page-sections') || null;
    }).catch(() => null);

    if (psId) {
      const sections = await client.getPageSections(psId);
      snapshotAfter = sections;
      console.log(`   ${sections.sections.length} sections captured`);
    }
  } catch (err) {
    console.log(`   ⚠️ Final snapshot failed: ${err instanceof Error ? err.message : err}`);
  }

  // Take after screenshot
  await page.screenshot({
    path: `${STORAGE_DIR}/after.png`,
    fullPage: true,
  });
  console.log('📸 After screenshot saved');

  // ── Save recording ──────────────────────────────────────────────────────
  const recording = {
    siteId,
    pageSlug,
    startedAt: apiCalls[0]?.timestamp ?? new Date().toISOString(),
    endedAt: new Date().toISOString(),
    notes,
    apiCalls,
    snapshotBefore,
    snapshotAfter,
    screenshots,
  };

  const recordingPath = `${STORAGE_DIR}/recording-${Date.now()}.json`;
  writeFileSync(recordingPath, JSON.stringify(recording, null, 2));
  console.log(`\n💾 Recording saved to ${recordingPath}`);

  // ── Diff summary ────────────────────────────────────────────────────────
  if (snapshotBefore && snapshotAfter) {
    console.log('\n📊 Change Summary:');
    const before = snapshotBefore as { sections: Array<{ id: string; fluidEngineContext?: { gridContents?: unknown[] } }> };
    const after = snapshotAfter as { sections: Array<{ id: string; fluidEngineContext?: { gridContents?: unknown[] } }> };

    const beforeIds = new Set(before.sections.map(s => s.id));
    const afterIds = new Set(after.sections.map(s => s.id));

    const added = after.sections.filter(s => !beforeIds.has(s.id));
    const removed = before.sections.filter(s => !afterIds.has(s.id));
    const common = after.sections.filter(s => beforeIds.has(s.id));

    if (added.length > 0) console.log(`   + ${added.length} sections added`);
    if (removed.length > 0) console.log(`   - ${removed.length} sections removed`);

    for (const s of common) {
      const beforeSection = before.sections.find(b => b.id === s.id);
      const beforeBlocks = beforeSection?.fluidEngineContext?.gridContents?.length ?? 0;
      const afterBlocks = s.fluidEngineContext?.gridContents?.length ?? 0;
      if (beforeBlocks !== afterBlocks) {
        console.log(`   ~ Section ${s.id.substring(0, 8)}: ${beforeBlocks} → ${afterBlocks} blocks`);
      }
    }

    // Count PUT calls (actual saves)
    const puts = apiCalls.filter(c => c.method === 'PUT');
    console.log(`   📡 ${puts.length} PUT calls (saves)`);
    console.log(`   📡 ${apiCalls.length} total API calls`);
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────
  await browser.close();
  rl.close();

  console.log('\n✅ Recording session complete!');
  console.log(`   View recording: ${recordingPath}`);
  console.log('   View screenshots: storage/recordings/\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
