/**
 * Dead-End Verification Script
 *
 * Re-probes Squarespace settings areas that previously returned 404 during
 * blind API probing. Navigates to each panel, makes a small change, saves,
 * captures network traffic, then reverts.
 *
 * Usage:
 *   npx tsx scripts/verify-dead-ends.ts                                # Run all actions
 *   npx tsx scripts/verify-dead-ends.ts --site smyth-tavern            # Different site
 *   npx tsx scripts/verify-dead-ends.ts --action social-links          # Single action
 *   npx tsx scripts/verify-dead-ends.ts --action social-links,popups   # Multiple actions
 *   npx tsx scripts/verify-dead-ends.ts --action all                   # Explicit all
 *   npx tsx scripts/verify-dead-ends.ts --headless                     # Run headless
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { Page } from 'playwright';
import { join } from 'path';
import { writeFile } from 'fs/promises';
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { resolveSite, navigateToSite } from '../src/automation/site-navigator.js';
import { discoverSites } from '../src/automation/site-discovery.js';
import { NetworkCapture, type CapturedRequest } from '../src/automation/network-capture.js';
import { errMsg } from '../src/utils/errors.js';

// ─── Types ─────────────────────────────────────────────────────────────────

interface DiscoveryAction {
  name: string;
  label: string;
  mutating: boolean;
  execute: (page: Page, ctx: ActionContext) => Promise<void>;
}

interface ActionContext {
  siteSubdomain: string;
}

interface ActionReport {
  name: string;
  label: string;
  requests: CapturedRequest[];
  error?: string;
  durationMs: number;
}

interface EndpointEntry {
  method: string;
  path: string;
  seenInActions: string[];
  responseStatuses: number[];
  hasRequestBody: boolean;
  sampleRequestBody?: unknown;
  sampleResponseBody?: unknown;
  queryParamKeys: string[];
}

// ─── CLI Flags ────────────────────────────────────────────────────────────

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : 'true';
      if (key === 'action' && flags[key]) {
        flags[key] += ',' + value;
      } else {
        flags[key] = value;
      }
      if (value !== 'true') i++;
    }
  }
  return flags;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Try navigating to multiple URL candidates, return the first that doesn't redirect to /config root */
async function tryNavigate(page: Page, urls: string[]): Promise<string | null> {
  for (const url of urls) {
    console.log(`    Trying: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(3000);
    const finalUrl = page.url();
    console.log(`    Landed: ${finalUrl}`);

    // If we didn't get redirected back to the bare /config dashboard, this URL worked
    if (!finalUrl.endsWith('/config') && !finalUrl.endsWith('/config/')) {
      return finalUrl;
    }
  }
  return null;
}

// ─── Discovery Actions ────────────────────────────────────────────────────

const ACTION_NAMES = [
  'social-links', 'announcement-bar', 'blog-scheduling', 'popups',
] as const;
type ActionName = typeof ACTION_NAMES[number];

function buildDiscoveryActions(): DiscoveryAction[] {
  return [
    // ── social-links ──────────────────────────────────────────────────
    {
      name: 'social-links',
      label: 'Settings > Social Links — add/edit a social link',
      mutating: true,
      execute: async (page, ctx) => {
        const base = `https://${ctx.siteSubdomain}.squarespace.com`;
        const landed = await tryNavigate(page, [
          `${base}/config/settings/social-links`,
          `${base}/config/settings/connected-accounts`,
          `${base}/config/settings/social`,
        ]);

        if (!landed) {
          console.log('    All social-links URLs redirected — dead end confirmed');
          return;
        }

        await page.waitForTimeout(4000);

        // Look for existing social link entries
        const existingLinks = page.locator(
          '[class*="social-link"], [class*="SocialLink"], ' +
          '[data-test*="social-link"], [class*="connected-account"]'
        );
        const linkCount = await existingLinks.count();
        console.log(`    Found ${linkCount} existing social link entries`);

        if (linkCount > 0) {
          // Click the first one to see read traffic
          await existingLinks.first().click();
          console.log('    Clicked first social link entry');
          await page.waitForTimeout(3000);
          await page.keyboard.press('Escape');
          await page.waitForTimeout(1000);
        }

        // Look for Add button
        const addBtn = page.locator(
          'button:has-text("Add"), button:has-text("Add Link"), ' +
          'button:has-text("Add Account"), button[aria-label*="Add"]'
        ).first();

        if (await addBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await addBtn.click();
          console.log('    Clicked Add button');
          await page.waitForTimeout(3000);

          // Try to find a URL input field
          const urlInput = page.locator(
            'input[type="url"], input[type="text"][placeholder*="URL" i], ' +
            'input[placeholder*="http" i], input[placeholder*="url" i], ' +
            'input[name*="url" i]'
          ).first();

          if (await urlInput.isVisible({ timeout: 3000 }).catch(() => false)) {
            await urlInput.fill('https://example.com/discovery-test');
            console.log('    Filled test URL');
            await page.waitForTimeout(1000);

            // Try to save
            const saveBtn = page.locator(
              'button:has-text("Save"), button:has-text("Done"), button:has-text("Apply")'
            ).first();
            if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
              await saveBtn.click();
              console.log('    Saved social link');
              await page.waitForTimeout(5000);

              // Revert: find and delete the test link
              const testLink = page.locator(':has-text("example.com/discovery-test")').first();
              if (await testLink.isVisible({ timeout: 2000 }).catch(() => false)) {
                await testLink.click();
                await page.waitForTimeout(1000);
              }
              const deleteBtn = page.locator(
                'button:has-text("Delete"), button:has-text("Remove"), ' +
                'button[aria-label*="Delete"], button[aria-label*="Remove"]'
              ).first();
              if (await deleteBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                await deleteBtn.click();
                console.log('    Deleted test link (reverted)');
                await page.waitForTimeout(3000);
                // Confirm delete if dialog appears
                const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("Delete")').last();
                if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                  await confirmBtn.click();
                  await page.waitForTimeout(3000);
                }
              }
            }
          } else {
            console.log('    No URL input found in add panel');
            await page.keyboard.press('Escape');
            await page.waitForTimeout(1000);
          }
        } else {
          console.log('    No Add button found');
        }

        // Also try Cmd+S to trigger any pending saves
        await page.keyboard.press('Meta+s');
        await page.waitForTimeout(3000);
      },
    },

    // ── announcement-bar ──────────────────────────────────────────────
    {
      name: 'announcement-bar',
      label: 'Settings > Announcement Bar — toggle on/off, change text',
      mutating: true,
      execute: async (page, ctx) => {
        const base = `https://${ctx.siteSubdomain}.squarespace.com`;
        const landed = await tryNavigate(page, [
          `${base}/config/settings/announcement-bar`,
          `${base}/config/design/announcement-bar`,
          `${base}/config/marketing/announcement-bar`,
          `${base}/config/design/announcement`,
          `${base}/config/marketing/announcement`,
        ]);

        if (!landed) {
          console.log('    All announcement-bar URLs redirected — dead end confirmed');
          return;
        }

        await page.waitForTimeout(4000);

        // Look for a toggle switch (checkbox, switch, toggle button)
        const toggle = page.locator(
          'input[type="checkbox"], [role="switch"], ' +
          '[class*="toggle"], [class*="Toggle"], ' +
          'button[aria-pressed], [class*="switch"]'
        ).first();

        let originalState: boolean | null = null;
        if (await toggle.isVisible({ timeout: 3000 }).catch(() => false)) {
          // Record current state
          const tagName = await toggle.evaluate((el) => el.tagName.toLowerCase());
          if (tagName === 'input') {
            originalState = await toggle.isChecked();
          } else {
            const pressed = await toggle.getAttribute('aria-pressed');
            const checked = await toggle.getAttribute('aria-checked');
            originalState = pressed === 'true' || checked === 'true';
          }
          console.log(`    Current toggle state: ${originalState}`);

          // Toggle it
          await toggle.click();
          console.log('    Toggled announcement bar');
          await page.waitForTimeout(2000);

          // If now on, look for text input
          const textInput = page.locator(
            'input[type="text"], textarea, [contenteditable="true"]'
          ).first();
          if (await textInput.isVisible({ timeout: 2000 }).catch(() => false)) {
            const currentText = await textInput.inputValue().catch(() => '');
            await textInput.fill('DISCOVERY TEST');
            console.log('    Typed "DISCOVERY TEST" in announcement text');
            await page.waitForTimeout(1000);

            // Save
            await page.keyboard.press('Meta+s');
            console.log('    Pressed Cmd+S');
            await page.waitForTimeout(5000);

            // Revert text
            await textInput.fill(currentText);
            await page.waitForTimeout(500);
          } else {
            // Save toggle state
            await page.keyboard.press('Meta+s');
            console.log('    Pressed Cmd+S');
            await page.waitForTimeout(5000);
          }

          // Revert toggle
          await toggle.click();
          console.log('    Reverted toggle');
          await page.waitForTimeout(1000);

          // Save reverted state
          const saveBtn = page.locator('button:has-text("Save"), button:has-text("Done")').first();
          if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await saveBtn.click();
            await page.waitForTimeout(3000);
          } else {
            await page.keyboard.press('Meta+s');
            await page.waitForTimeout(3000);
          }
          console.log('    Reverted and saved');
        } else {
          console.log('    No toggle found — looking for other controls...');

          // Try clicking any visible buttons/links in the panel
          const panelBtns = page.locator(
            '[class*="announcement"] button, [class*="Announcement"] button'
          );
          const btnCount = await panelBtns.count();
          console.log(`    Found ${btnCount} buttons in announcement area`);
        }
      },
    },

    // ── blog-scheduling ───────────────────────────────────────────────
    {
      name: 'blog-scheduling',
      label: 'Blog post editor — set scheduled publish date',
      mutating: true,
      execute: async (page, ctx) => {
        const base = `https://${ctx.siteSubdomain}.squarespace.com`;

        // Navigate to pages panel
        const pagesUrl = `${base}/config/pages`;
        console.log(`    Navigating to: ${pagesUrl}`);
        await page.goto(pagesUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(4000);

        // Find a blog collection
        const blogItem = page.locator(
          '[data-test="pages-panel-item"]:has-text("Blog"), ' +
          '[data-test="pages-panel-item"]:has-text("News"), ' +
          '[data-test="pages-panel-item"]:has-text("Posts"), ' +
          '[data-test="pages-panel-collection"]:has-text("Blog")'
        ).first();

        if (!(await blogItem.isVisible({ timeout: 5000 }).catch(() => false))) {
          console.log('    No blog collection found on this site — dead end for scheduling');
          return;
        }

        console.log('    Found blog collection — clicking to expand');
        await blogItem.click();
        await page.waitForTimeout(3000);

        // Look for existing blog posts or a "+" to create a draft
        const postItems = page.locator(
          '[data-test="blog-item"], [class*="blog-item"], ' +
          '[class*="BlogItem"], [data-test*="post"]'
        );
        const postCount = await postItems.count();
        console.log(`    Found ${postCount} blog posts`);

        // Try to create a new draft if there's an add button
        const addBtn = page.locator(
          'button[aria-label*="Add"], button:has-text("+"), ' +
          'button[data-test*="add"], button:has-text("New Post")'
        ).first();

        let createdDraft = false;
        if (await addBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await addBtn.click();
          console.log('    Clicked Add to create new draft');
          await page.waitForTimeout(5000);
          createdDraft = true;
        } else if (postCount > 0) {
          // Click the first existing post to open it
          await postItems.first().click();
          console.log('    Clicked first existing post');
          await page.waitForTimeout(4000);
        } else {
          console.log('    No posts and no Add button found');
          return;
        }

        // Look for scheduling controls
        // Check for a "Schedule" button, date picker, or publish settings
        const scheduleBtn = page.locator(
          'button:has-text("Schedule"), button:has-text("Publish"), ' +
          '[data-test*="schedule"], [class*="schedule" i], ' +
          'button:has-text("Save & Publish"), [class*="publish" i]'
        ).first();

        if (await scheduleBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await scheduleBtn.click();
          console.log('    Clicked Schedule/Publish button');
          await page.waitForTimeout(3000);

          // Look for date picker or scheduling options
          const datePicker = page.locator(
            'input[type="date"], input[type="datetime-local"], ' +
            '[class*="date-picker"], [class*="DatePicker"], ' +
            '[class*="calendar"], input[placeholder*="date" i]'
          ).first();

          if (await datePicker.isVisible({ timeout: 3000 }).catch(() => false)) {
            console.log('    Found date picker — scheduling UI confirmed');
            // Don't actually set a date, just capture the traffic from opening it
            await page.waitForTimeout(2000);
          } else {
            console.log('    No date picker found in scheduling panel');
          }

          await page.keyboard.press('Escape');
          await page.waitForTimeout(1000);
        } else {
          console.log('    No Schedule/Publish button found');

          // Try looking in a settings/gear menu for the post
          const settingsBtn = page.locator(
            'button[aria-label*="Settings" i], button[aria-label*="options" i], ' +
            '[data-test*="settings"], button:has-text("Settings")'
          ).first();

          if (await settingsBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await settingsBtn.click();
            console.log('    Opened post settings');
            await page.waitForTimeout(3000);

            // Look for publish date / scheduling in settings
            const publishSection = page.locator(
              ':has-text("Publish"), :has-text("Schedule"), ' +
              ':has-text("Date"), [class*="publish" i]'
            ).first();

            if (await publishSection.isVisible({ timeout: 2000 }).catch(() => false)) {
              console.log('    Found publish/schedule section in settings');
            }

            await page.keyboard.press('Escape');
            await page.waitForTimeout(1000);
          }
        }

        // Clean up: discard draft if we created one
        if (createdDraft) {
          await page.keyboard.press('Escape');
          await page.waitForTimeout(1000);

          const discardBtn = page.locator(
            'button:has-text("Discard"), button:has-text("Delete"), ' +
            'button:has-text("Don\'t Save"), button:has-text("Cancel")'
          ).first();
          if (await discardBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await discardBtn.click();
            console.log('    Discarded draft');
            await page.waitForTimeout(3000);

            // Confirm if dialog appears
            const confirmBtn = page.locator(
              'button:has-text("Confirm"), button:has-text("Discard"), button:has-text("Delete")'
            ).last();
            if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
              await confirmBtn.click();
              await page.waitForTimeout(2000);
            }
          }
        } else {
          await page.keyboard.press('Escape');
          await page.waitForTimeout(1000);
        }
      },
    },

    // ── popups ────────────────────────────────────────────────────────
    {
      name: 'popups',
      label: 'Settings > Marketing > Promotional Popup — toggle on/off',
      mutating: true,
      execute: async (page, ctx) => {
        const base = `https://${ctx.siteSubdomain}.squarespace.com`;
        const landed = await tryNavigate(page, [
          `${base}/config/marketing/promotional-popup`,
          `${base}/config/settings/promotional-popup`,
          `${base}/config/marketing/popups`,
          `${base}/config/marketing/popup`,
          `${base}/config/settings/popup`,
          `${base}/config/marketing`,
        ]);

        if (!landed) {
          console.log('    All popup URLs redirected — dead end confirmed');
          return;
        }

        await page.waitForTimeout(4000);
        console.log(`    Landed on: ${page.url()}`);

        // If we landed on /config/marketing, look for a "Promotional Pop-up" link
        if (page.url().endsWith('/marketing') || page.url().endsWith('/marketing/')) {
          const popupLink = page.locator(
            'a:has-text("Pop-up"), a:has-text("Popup"), a:has-text("Promotional"), ' +
            'button:has-text("Pop-up"), button:has-text("Popup"), ' +
            '[class*="popup" i], [class*="pop-up" i]'
          ).first();

          if (await popupLink.isVisible({ timeout: 3000 }).catch(() => false)) {
            await popupLink.click();
            console.log('    Clicked popup link in marketing panel');
            await page.waitForTimeout(4000);
          } else {
            console.log('    No popup link found in marketing panel');
            // List all links/buttons for debugging
            const allLinks = page.locator('a, button');
            const count = await allLinks.count();
            const texts: string[] = [];
            for (let i = 0; i < Math.min(count, 20); i++) {
              const text = await allLinks.nth(i).innerText().catch(() => '');
              if (text.trim()) texts.push(text.trim());
            }
            console.log(`    Visible controls: ${texts.join(' | ')}`);
          }
        }

        // Look for a toggle switch
        const toggle = page.locator(
          'input[type="checkbox"], [role="switch"], ' +
          '[class*="toggle"], [class*="Toggle"], ' +
          'button[aria-pressed], [class*="switch"]'
        ).first();

        let originalState: boolean | null = null;
        if (await toggle.isVisible({ timeout: 3000 }).catch(() => false)) {
          const tagName = await toggle.evaluate((el) => el.tagName.toLowerCase());
          if (tagName === 'input') {
            originalState = await toggle.isChecked();
          } else {
            const pressed = await toggle.getAttribute('aria-pressed');
            const checked = await toggle.getAttribute('aria-checked');
            originalState = pressed === 'true' || checked === 'true';
          }
          console.log(`    Current popup toggle state: ${originalState}`);

          // Toggle
          await toggle.click();
          console.log('    Toggled popup');
          await page.waitForTimeout(2000);

          // If a text input appears, type test text
          const textInput = page.locator(
            'input[type="text"], textarea, [contenteditable="true"]'
          ).first();
          if (await textInput.isVisible({ timeout: 2000 }).catch(() => false)) {
            const currentText = await textInput.inputValue().catch(() => '');
            await textInput.fill('DISCOVERY TEST POPUP');
            console.log('    Typed test text');
            await page.waitForTimeout(1000);

            // Save
            await page.keyboard.press('Meta+s');
            console.log('    Pressed Cmd+S');
            await page.waitForTimeout(5000);

            // Revert text
            await textInput.fill(currentText);
            await page.waitForTimeout(500);
          } else {
            await page.keyboard.press('Meta+s');
            console.log('    Pressed Cmd+S');
            await page.waitForTimeout(5000);
          }

          // Revert toggle
          await toggle.click();
          console.log('    Reverted toggle');
          await page.waitForTimeout(1000);

          // Save reverted state
          const saveBtn = page.locator('button:has-text("Save"), button:has-text("Done")').first();
          if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await saveBtn.click();
            await page.waitForTimeout(3000);
          } else {
            await page.keyboard.press('Meta+s');
            await page.waitForTimeout(3000);
          }
          console.log('    Reverted and saved');
        } else {
          console.log('    No toggle found on popup panel');

          // Look for any visible form controls
          const inputs = page.locator('input, textarea, select, [contenteditable="true"]');
          const inputCount = await inputs.count();
          console.log(`    Found ${inputCount} form inputs on page`);

          // Try clicking any visible buttons to explore
          const buttons = page.locator('button');
          const btnCount = await buttons.count();
          const btnTexts: string[] = [];
          for (let i = 0; i < Math.min(btnCount, 15); i++) {
            const text = await buttons.nth(i).innerText().catch(() => '');
            if (text.trim()) btnTexts.push(text.trim());
          }
          console.log(`    Buttons found: ${btnTexts.join(' | ')}`);
        }
      },
    },
  ];
}

// ─── Report Generation ────────────────────────────────────────────────────

function buildEndpointCatalog(reports: ActionReport[]): EndpointEntry[] {
  const endpointMap = new Map<string, EndpointEntry>();

  for (const report of reports) {
    for (const req of report.requests) {
      const key = `${req.method} ${req.path}`;
      let entry = endpointMap.get(key);
      if (!entry) {
        entry = {
          method: req.method,
          path: req.path,
          seenInActions: [],
          responseStatuses: [],
          hasRequestBody: false,
          queryParamKeys: [],
        };
        endpointMap.set(key, entry);
      }

      if (!entry.seenInActions.includes(report.name)) {
        entry.seenInActions.push(report.name);
      }
      if (req.responseStatus !== null && !entry.responseStatuses.includes(req.responseStatus)) {
        entry.responseStatuses.push(req.responseStatus);
      }
      if (req.requestBody) {
        entry.hasRequestBody = true;
        if (!entry.sampleRequestBody) entry.sampleRequestBody = req.requestBody;
      }
      if (req.responseBody && !entry.sampleResponseBody) {
        entry.sampleResponseBody = req.responseBody;
      }
      for (const k of Object.keys(req.queryParams)) {
        if (!entry.queryParamKeys.includes(k)) {
          entry.queryParamKeys.push(k);
        }
      }
    }
  }

  const methodOrder: Record<string, number> = { POST: 0, PUT: 1, PATCH: 2, DELETE: 3, GET: 4 };
  return Array.from(endpointMap.values()).sort((a, b) => {
    const orderA = methodOrder[a.method] ?? 5;
    const orderB = methodOrder[b.method] ?? 5;
    if (orderA !== orderB) return orderA - orderB;
    return a.path.localeCompare(b.path);
  });
}

function printReport(reports: ActionReport[], catalog: EndpointEntry[], siteId: string): void {
  const totalRequests = reports.reduce((sum, r) => sum + r.requests.length, 0);

  console.log('\n' + '='.repeat(70));
  console.log('  DEAD-END VERIFICATION REPORT');
  console.log('='.repeat(70));
  console.log(`  Site:      ${siteId}`);
  console.log(`  Actions:   ${reports.length}`);
  console.log(`  Total API requests captured: ${totalRequests}`);

  console.log('\n' + '-'.repeat(70));
  console.log('  PER-ACTION CAPTURES');
  console.log('-'.repeat(70));

  for (const report of reports) {
    const status = report.error ? `ERROR: ${report.error}` : `${report.requests.length} requests`;
    console.log(`\n  ${report.label} [${report.name}] (${(report.durationMs / 1000).toFixed(1)}s) — ${status}`);

    // Show write operations and key API calls
    const interesting = report.requests.filter(
      (r) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) || r.path.includes('/api/'),
    );
    for (const req of interesting) {
      const statusStr = req.responseStatus !== null ? `[${req.responseStatus}]` : '';
      const durStr = req.durationMs !== null ? `(${req.durationMs}ms)` : '';
      const bodyStr = req.requestBody ? ' [body]' : '';
      console.log(`    ${req.method.padEnd(7)} ${req.path} ${statusStr} ${durStr}${bodyStr}`);
      if (Object.keys(req.queryParams).length > 0) {
        console.log(`            query: ${JSON.stringify(req.queryParams)}`);
      }
    }

    const writeCount = report.requests.filter(
      (r) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method),
    ).length;
    console.log(`    Endpoints found: ${report.requests.length} (${writeCount} write)`);
  }

  // Write endpoints summary
  const writeOps = catalog.filter((e) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(e.method));
  if (writeOps.length > 0) {
    console.log('\n' + '-'.repeat(70));
    console.log('  WRITE ENDPOINTS DISCOVERED');
    console.log('-'.repeat(70));

    for (const entry of writeOps) {
      const statuses = entry.responseStatuses.join(',');
      const params = entry.queryParamKeys.length > 0 ? ` ?${entry.queryParamKeys.join('&')}` : '';
      const actions = entry.seenInActions.join(', ');
      console.log(`\n    ${entry.method.padEnd(7)} ${entry.path}${params}`);
      console.log(`            status: ${statuses}  from: ${actions}`);

      if (entry.sampleRequestBody) {
        const bodyStr = JSON.stringify(entry.sampleRequestBody, null, 2);
        const truncated = bodyStr.length > 500 ? bodyStr.substring(0, 500) + '\n            ...' : bodyStr;
        console.log(`            request body:\n${truncated.split('\n').map((l) => '              ' + l).join('\n')}`);
      }
    }
  }

  // Dead-end summary
  console.log('\n' + '-'.repeat(70));
  console.log('  DEAD-END STATUS SUMMARY');
  console.log('-'.repeat(70));

  for (const report of reports) {
    const writeCount = report.requests.filter(
      (r) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method),
    ).length;
    const apiCount = report.requests.filter((r) => r.path.includes('/api/')).length;

    let verdict: string;
    if (report.error) {
      verdict = 'ERROR — could not test';
    } else if (writeCount > 0) {
      verdict = `ALIVE — ${writeCount} write endpoint(s) found`;
    } else if (apiCount > 0) {
      verdict = `PARTIAL — ${apiCount} API call(s) but no writes`;
    } else if (report.requests.length > 0) {
      verdict = `MINIMAL — ${report.requests.length} request(s), no API calls`;
    } else {
      verdict = 'DEAD — no requests captured';
    }

    console.log(`  ${report.name.padEnd(20)} ${verdict}`);
  }

  console.log(`\n  Unique endpoints: ${catalog.length}`);
  console.log(`  Write endpoints: ${writeOps.length}`);
  console.log('='.repeat(70));
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const siteId = flags.site ?? 'tim-cox';
  const headless = flags.headless === 'true';
  const actionFlag = flags.action;
  const actionFilter = actionFlag && actionFlag !== 'all'
    ? actionFlag.split(',')
    : null;

  // Validate --action flags
  if (actionFilter) {
    const invalid = actionFilter.filter((a) => !ACTION_NAMES.includes(a as ActionName));
    if (invalid.length > 0) {
      console.error(`Unknown action(s): ${invalid.join(', ')}`);
      console.error(`Available: ${ACTION_NAMES.join(', ')}, all`);
      process.exit(1);
    }
  }

  console.log(`\n  Squarespace Dead-End Verification`);
  console.log(`  Site: ${siteId}`);
  if (actionFilter) {
    console.log(`  Actions: ${actionFilter.join(', ')}`);
  } else {
    console.log(`  Actions: all (${ACTION_NAMES.join(', ')})`);
  }
  console.log('');

  const browserManager = getBrowserManager({ headless });

  try {
    await browserManager.initialize();
    await ensureLoggedIn(browserManager);
    const page = await browserManager.getPage();

    await discoverSites(page);
    const client = await resolveSite(siteId, page);
    console.log(`  Resolved site: ${client.name} (${client.site.adminUrl})\n`);

    await navigateToSite(page, client);

    // Extract subdomain for URL construction
    const ctx: ActionContext = {
      siteSubdomain: client.site.adminUrl.match(/https:\/\/([^.]+)/)?.[1] ?? siteId,
    };

    // Network capture — include all requests
    const capture = new NetworkCapture(page, {
      includePatterns: [/.*/],
    });

    const actions = buildDiscoveryActions();
    const reports: ActionReport[] = [];

    for (const action of actions) {
      if (actionFilter && !actionFilter.includes(action.name)) continue;

      console.log(`  [RUN]  ${action.label}`);
      capture.clear();
      await capture.start();
      const startMs = Date.now();

      try {
        await action.execute(page, ctx);
        capture.stop();
        const requests = capture.getCapturedRequests();
        const durationMs = Date.now() - startMs;
        reports.push({ name: action.name, label: action.label, requests, durationMs });
        console.log(`         Captured ${requests.length} request(s) (${(durationMs / 1000).toFixed(1)}s)`);
      } catch (err) {
        capture.stop();
        const error = errMsg(err);
        const durationMs = Date.now() - startMs;
        reports.push({
          name: action.name,
          label: action.label,
          requests: capture.getCapturedRequests(),
          error,
          durationMs,
        });
        console.log(`         ERROR: ${error}`);
      }
    }

    const catalog = buildEndpointCatalog(reports);

    // Save full capture to JSON
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outputPath = join(process.cwd(), 'data', `dead-ends-verification-${timestamp}.json`);

    const output = {
      capturedAt: new Date().toISOString(),
      siteId,
      crumbToken: capture.getCrumbToken(),
      summary: {
        totalActions: reports.length,
        totalRequests: reports.reduce((s, r) => s + r.requests.length, 0),
        uniqueEndpoints: catalog.length,
        writeEndpoints: catalog.filter((e) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(e.method)).length,
        actionsWithErrors: reports.filter((r) => r.error).length,
      },
      endpointCatalog: catalog,
      actionReports: reports.map((r) => ({
        name: r.name,
        label: r.label,
        error: r.error ?? null,
        durationMs: r.durationMs,
        requestCount: r.requests.length,
        requests: r.requests,
      })),
    };

    await writeFile(outputPath, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`\n  Full capture saved to: ${outputPath}`);

    printReport(reports, catalog, siteId);

    await browserManager.saveSession();

    if (!headless) {
      console.log('\n  Browser is still open for inspection. Press Ctrl+C to close.\n');
      await new Promise(() => {});
    } else {
      await browserManager.close();
    }
  } catch (err) {
    console.error(`\n  Fatal error: ${errMsg(err)}\n`);
    await browserManager.close();
    process.exit(1);
  }
}

main();
