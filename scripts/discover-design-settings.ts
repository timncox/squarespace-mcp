/**
 * Design Settings API Discovery Script
 *
 * Launches a browser, logs into Squarespace, and captures network traffic
 * when changing fonts and colors in the Design > Site Styles panel to
 * discover the internal API endpoints for design/theme settings.
 *
 * Hypothesis: Save endpoints likely follow `/api/template/Save*` or
 * `/api/config/Save*` pattern (similar to SaveTemplateCustomCss and
 * SaveInjectionSettings).
 *
 * Usage:
 *   npx tsx scripts/discover-design-settings.ts                      # Both font + color discovery
 *   npx tsx scripts/discover-design-settings.ts --site smyth-tavern  # Different site
 *   npx tsx scripts/discover-design-settings.ts --action font        # Font discovery only
 *   npx tsx scripts/discover-design-settings.ts --action color       # Color discovery only
 *   npx tsx scripts/discover-design-settings.ts --headless           # Run headless
 *   npx tsx scripts/discover-design-settings.ts --manual            # Manual mode: you click, script captures
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { Page } from 'playwright';
import { join } from 'path';
import { writeFile } from 'fs/promises';
import { createInterface } from 'readline';
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

// ─── Discovery Actions ────────────────────────────────────────────────────

const ACTION_NAMES = ['font', 'color'] as const;
type ActionName = typeof ACTION_NAMES[number];

function buildDiscoveryActions(): DiscoveryAction[] {
  return [
    // ── Font Discovery ──────────────────────────────────────────────────
    {
      name: 'font',
      label: 'Change a heading font in Site Styles and capture save API',
      mutating: true,
      execute: async (page, ctx) => {
        // Navigate to Site Styles
        const stylesUrl = `https://${ctx.siteSubdomain}.squarespace.com/config/design/site-styles`;
        console.log(`    Navigating to: ${stylesUrl}`);
        await page.goto(stylesUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(4000);

        // Look for the Fonts section/button — try multiple selectors
        const fontsSelectors = [
          'button:has-text("Fonts")',
          '[data-test*="font"]',
          'h2:has-text("Fonts")',
          'h3:has-text("Fonts")',
          'div[role="button"]:has-text("Fonts")',
          'a:has-text("Fonts")',
          // Squarespace 7.1 panel items
          '[class*="SiteStylesItem"]:has-text("Fonts")',
          '[class*="site-styles"]:has-text("Fonts")',
        ];

        let fontsClicked = false;
        for (const selector of fontsSelectors) {
          const el = page.locator(selector).first();
          if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
            await el.click();
            console.log(`    Clicked Fonts via: ${selector}`);
            fontsClicked = true;
            await page.waitForTimeout(3000);
            break;
          }
        }

        if (!fontsClicked) {
          // Fallback: try clicking any text that says "Fonts" on the page
          console.log('    Primary selectors failed — trying text scan...');
          const allButtons = page.locator('button, [role="button"], a, div[tabindex]');
          const count = await allButtons.count();
          for (let i = 0; i < count; i++) {
            const text = await allButtons.nth(i).innerText().catch(() => '');
            if (text.trim() === 'Fonts' || text.trim().startsWith('Fonts')) {
              await allButtons.nth(i).click();
              console.log(`    Clicked Fonts via text scan at index ${i}`);
              fontsClicked = true;
              await page.waitForTimeout(3000);
              break;
            }
          }
        }

        if (!fontsClicked) {
          console.log('    Could not find Fonts section — dumping visible elements...');
          // Log what we can see for debugging
          const visibleText = await page.evaluate(() => {
            const elements = document.querySelectorAll('button, [role="button"], h2, h3, a');
            return Array.from(elements)
              .map((el) => (el as HTMLElement).innerText?.trim())
              .filter(Boolean)
              .slice(0, 30);
          });
          console.log(`    Visible interactive elements: ${JSON.stringify(visibleText)}`);
          return;
        }

        // Now in the Fonts panel — find font pickers
        // Look for heading font dropdown/button/select
        const fontPickerSelectors = [
          // Heading font pickers
          'button:has-text("Heading")',
          '[data-test*="heading-font"]',
          '[class*="FontPicker"]',
          '[class*="font-picker"]',
          'select[name*="font"]',
          // Any dropdown that looks like a font picker
          '[class*="Dropdown"]:has-text("font")',
          'button[class*="font" i]',
          // Generic selects/dropdowns in the panel
          'select',
          '[role="listbox"]',
          '[role="combobox"]',
        ];

        let fontPickerClicked = false;
        for (const selector of fontPickerSelectors) {
          const el = page.locator(selector).first();
          if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
            await el.click();
            console.log(`    Opened font picker via: ${selector}`);
            fontPickerClicked = true;
            await page.waitForTimeout(2000);
            break;
          }
        }

        if (!fontPickerClicked) {
          // Try scanning for any clickable element that contains a font name
          console.log('    Font picker not found — trying to find font-related elements...');
          const panelElements = page.locator('[class*="panel"] button, [class*="Panel"] button, [class*="modal"] button');
          const pCount = await panelElements.count();
          console.log(`    Found ${pCount} buttons in panels`);
          for (let i = 0; i < Math.min(pCount, 20); i++) {
            const text = await panelElements.nth(i).innerText().catch(() => '');
            console.log(`      Button ${i}: "${text}"`);
          }
          // Click the first substantial button we find
          if (pCount > 0) {
            await panelElements.first().click();
            console.log('    Clicked first panel button as fallback');
            fontPickerClicked = true;
            await page.waitForTimeout(2000);
          }
        }

        if (!fontPickerClicked) {
          console.log('    Could not find any font picker — capturing current state');
          await page.waitForTimeout(3000);
          return;
        }

        // Try to select a different font option
        const fontOptionSelectors = [
          '[role="option"]',
          '[class*="FontOption"]',
          '[class*="font-option"]',
          '[class*="DropdownItem"]',
          '[class*="dropdown-item"]',
          'li[role="option"]',
          '[class*="listbox"] li',
          '[class*="font-family"]',
        ];

        let fontChanged = false;
        for (const selector of fontOptionSelectors) {
          // Try to click the second option (first might be currently selected)
          const options = page.locator(selector);
          const optCount = await options.count();
          if (optCount >= 2) {
            // Click the second font option to change
            await options.nth(1).click();
            console.log(`    Selected different font option via: ${selector} (${optCount} options available)`);
            fontChanged = true;
            await page.waitForTimeout(3000);
            break;
          } else if (optCount === 1) {
            await options.first().click();
            console.log(`    Clicked only font option via: ${selector}`);
            fontChanged = true;
            await page.waitForTimeout(3000);
            break;
          }
        }

        if (!fontChanged) {
          console.log('    Could not find font options to select — trying keyboard approach');
          // Try arrow keys to change selection
          await page.keyboard.press('ArrowDown');
          await page.waitForTimeout(500);
          await page.keyboard.press('Enter');
          await page.waitForTimeout(3000);
        }

        // Wait for any autosave
        console.log('    Waiting for autosave or pending save...');
        await page.waitForTimeout(5000);

        // Try explicit save: look for Save/Apply/Done button
        const saveSelectors = [
          'button:has-text("Save")',
          'button:has-text("Apply")',
          'button:has-text("Done")',
          'button[data-test*="save"]',
          'button[data-test*="apply"]',
        ];

        for (const selector of saveSelectors) {
          const saveBtn = page.locator(selector).first();
          if (await saveBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
            await saveBtn.click();
            console.log(`    Clicked save via: ${selector}`);
            await page.waitForTimeout(5000);
            break;
          }
        }

        // Also try Cmd+S
        console.log('    Trying Cmd+S...');
        await page.keyboard.press('Meta+s');
        await page.waitForTimeout(5000);

        // Revert: undo multiple times
        console.log('    Reverting font change with Cmd+Z...');
        for (let i = 0; i < 10; i++) {
          await page.keyboard.press('Meta+z');
          await page.waitForTimeout(300);
        }
        await page.waitForTimeout(2000);

        // Save the reverted state
        for (const selector of saveSelectors) {
          const saveBtn = page.locator(selector).first();
          if (await saveBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
            await saveBtn.click();
            console.log(`    Saved revert via: ${selector}`);
            await page.waitForTimeout(5000);
            break;
          }
        }
        await page.keyboard.press('Meta+s');
        await page.waitForTimeout(3000);
      },
    },

    // ── Color Discovery ─────────────────────────────────────────────────
    {
      name: 'color',
      label: 'Change a theme color in Site Styles and capture save API',
      mutating: true,
      execute: async (page, ctx) => {
        // Navigate to Site Styles
        const stylesUrl = `https://${ctx.siteSubdomain}.squarespace.com/config/design/site-styles`;
        console.log(`    Navigating to: ${stylesUrl}`);
        await page.goto(stylesUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(4000);

        // Look for the Colors section/button
        const colorSelectors = [
          'button:has-text("Colors")',
          '[data-test*="color"]',
          'h2:has-text("Colors")',
          'h3:has-text("Colors")',
          'div[role="button"]:has-text("Colors")',
          'a:has-text("Colors")',
          '[class*="SiteStylesItem"]:has-text("Colors")',
          '[class*="site-styles"]:has-text("Colors")',
        ];

        let colorsClicked = false;
        for (const selector of colorSelectors) {
          const el = page.locator(selector).first();
          if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
            await el.click();
            console.log(`    Clicked Colors via: ${selector}`);
            colorsClicked = true;
            await page.waitForTimeout(3000);
            break;
          }
        }

        if (!colorsClicked) {
          // Fallback: text scan
          console.log('    Primary selectors failed — trying text scan...');
          const allButtons = page.locator('button, [role="button"], a, div[tabindex]');
          const count = await allButtons.count();
          for (let i = 0; i < count; i++) {
            const text = await allButtons.nth(i).innerText().catch(() => '');
            if (text.trim() === 'Colors' || text.trim().startsWith('Colors')) {
              await allButtons.nth(i).click();
              console.log(`    Clicked Colors via text scan at index ${i}`);
              colorsClicked = true;
              await page.waitForTimeout(3000);
              break;
            }
          }
        }

        if (!colorsClicked) {
          console.log('    Could not find Colors section — dumping visible elements...');
          const visibleText = await page.evaluate(() => {
            const elements = document.querySelectorAll('button, [role="button"], h2, h3, a');
            return Array.from(elements)
              .map((el) => (el as HTMLElement).innerText?.trim())
              .filter(Boolean)
              .slice(0, 30);
          });
          console.log(`    Visible interactive elements: ${JSON.stringify(visibleText)}`);
          return;
        }

        // Now in the Colors panel — find color swatches or inputs
        const colorPickerSelectors = [
          // Color swatches
          '[class*="ColorSwatch"]',
          '[class*="color-swatch"]',
          '[class*="swatch"]',
          '[data-test*="color-swatch"]',
          // Color palette options
          '[class*="Palette"]',
          '[class*="palette"]',
          '[class*="ThemeColor"]',
          '[class*="theme-color"]',
          // Color input
          'input[type="color"]',
          'input[name*="color" i]',
          // Generic clickable color elements
          '[class*="ColorPicker"]',
          '[class*="color-picker"]',
          // Circles or rounded elements that could be swatches
          '[class*="circle"]',
          '[class*="Circle"]',
        ];

        let colorClicked = false;
        for (const selector of colorPickerSelectors) {
          const els = page.locator(selector);
          const elCount = await els.count();
          if (elCount >= 2) {
            // Click the second swatch (first is likely the current selection)
            await els.nth(1).click();
            console.log(`    Clicked color swatch via: ${selector} (${elCount} swatches found)`);
            colorClicked = true;
            await page.waitForTimeout(3000);
            break;
          } else if (elCount === 1) {
            await els.first().click();
            console.log(`    Clicked single color element via: ${selector}`);
            colorClicked = true;
            await page.waitForTimeout(3000);
            break;
          }
        }

        if (!colorClicked) {
          // Try to find a hex color input and modify it
          console.log('    No swatch found — looking for hex color input...');
          const hexInput = page.locator('input[value*="#"], input[placeholder*="#"], input[type="text"][maxlength="7"]').first();
          if (await hexInput.isVisible({ timeout: 2000 }).catch(() => false)) {
            const currentValue = await hexInput.inputValue();
            console.log(`    Found hex input with value: ${currentValue}`);
            // Change to a different color
            await hexInput.fill('#FF0000');
            await page.keyboard.press('Enter');
            console.log('    Changed color to #FF0000');
            colorClicked = true;
            await page.waitForTimeout(3000);
          }
        }

        if (!colorClicked) {
          // Last resort: dump panel contents for debugging
          console.log('    Could not find any color picker — scanning panel...');
          const panelElements = page.locator('[class*="panel"] *, [class*="Panel"] *, [class*="modal"] *');
          const pCount = await panelElements.count();
          console.log(`    Found ${pCount} elements in panels`);
          // Log first 20 clickable elements
          const clickable = page.locator('[class*="panel"] button, [class*="panel"] [role="button"], [class*="panel"] input, [class*="Panel"] button');
          const cCount = await clickable.count();
          for (let i = 0; i < Math.min(cCount, 20); i++) {
            const tag = await clickable.nth(i).evaluate((el) => el.tagName).catch(() => '?');
            const cls = await clickable.nth(i).evaluate((el) => el.className).catch(() => '?');
            const text = await clickable.nth(i).innerText().catch(() => '');
            console.log(`      ${tag} class="${String(cls).substring(0, 60)}" text="${text.substring(0, 40)}"`);
          }
          await page.waitForTimeout(3000);
          return;
        }

        // Wait for autosave
        console.log('    Waiting for autosave...');
        await page.waitForTimeout(5000);

        // Try explicit save
        const saveSelectors = [
          'button:has-text("Save")',
          'button:has-text("Apply")',
          'button:has-text("Done")',
          'button[data-test*="save"]',
          'button[data-test*="apply"]',
        ];

        for (const selector of saveSelectors) {
          const saveBtn = page.locator(selector).first();
          if (await saveBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
            await saveBtn.click();
            console.log(`    Clicked save via: ${selector}`);
            await page.waitForTimeout(5000);
            break;
          }
        }

        // Try Cmd+S
        console.log('    Trying Cmd+S...');
        await page.keyboard.press('Meta+s');
        await page.waitForTimeout(5000);

        // Revert: undo multiple times
        console.log('    Reverting color change with Cmd+Z...');
        for (let i = 0; i < 10; i++) {
          await page.keyboard.press('Meta+z');
          await page.waitForTimeout(300);
        }
        await page.waitForTimeout(2000);

        // Save the reverted state
        for (const selector of saveSelectors) {
          const saveBtn = page.locator(selector).first();
          if (await saveBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
            await saveBtn.click();
            console.log(`    Saved revert via: ${selector}`);
            await page.waitForTimeout(5000);
            break;
          }
        }
        await page.keyboard.press('Meta+s');
        await page.waitForTimeout(3000);
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
  console.log('  DESIGN SETTINGS API DISCOVERY REPORT');
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

    // Show write operations and /api/ requests
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
  }

  // Write operations summary
  const writeOps = catalog.filter((e) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(e.method));
  if (writeOps.length > 0) {
    console.log('\n' + '-'.repeat(70));
    console.log('  WRITE ENDPOINTS (most interesting for design settings API)');
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

  // ── Hypothesis Check ──────────────────────────────────────────────
  console.log('\n' + '-'.repeat(70));
  console.log('  HYPOTHESIS CHECK');
  console.log('-'.repeat(70));

  const templateSaveEndpoints = catalog.filter((e) => /\/api\/template\/Save/i.test(e.path));
  const configSaveEndpoints = catalog.filter((e) => /\/api\/config\/Save/i.test(e.path));
  const designEndpoints = catalog.filter((e) => /\/api\/(template|config|design|style)/i.test(e.path));

  if (templateSaveEndpoints.length > 0) {
    console.log(`  FOUND /api/template/Save* endpoints (${templateSaveEndpoints.length}):`);
    for (const ep of templateSaveEndpoints) {
      console.log(`    ${ep.method} ${ep.path}`);
    }
  } else {
    console.log('  No /api/template/Save* endpoints found');
  }

  if (configSaveEndpoints.length > 0) {
    console.log(`  FOUND /api/config/Save* endpoints (${configSaveEndpoints.length}):`);
    for (const ep of configSaveEndpoints) {
      console.log(`    ${ep.method} ${ep.path}`);
    }
  } else {
    console.log('  No /api/config/Save* endpoints found');
  }

  if (designEndpoints.length > 0) {
    console.log(`\n  All design-related endpoints (${designEndpoints.length}):`);
    for (const ep of designEndpoints) {
      const statuses = ep.responseStatuses.join(',');
      const body = ep.hasRequestBody ? ' [body]' : '';
      console.log(`    ${ep.method.padEnd(7)} ${ep.path} [${statuses}]${body}`);
    }
  }

  console.log(`\n  Unique endpoints: ${catalog.length}`);
  console.log(`  Write endpoints: ${writeOps.length}`);
  console.log('='.repeat(70));
}

// ─── Main ─────────────────────────────────────────────────────────────────

function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const siteId = flags.site ?? 'tim-cox';
  const headless = flags.headless === 'true';
  const manual = flags.manual === 'true';
  const actionFilter = flags.action ? flags.action.split(',') : null;

  // Validate --action flags
  if (actionFilter && !manual) {
    const invalid = actionFilter.filter((a) => !ACTION_NAMES.includes(a as ActionName));
    if (invalid.length > 0) {
      console.error(`Unknown action(s): ${invalid.join(', ')}`);
      console.error(`Available: ${ACTION_NAMES.join(', ')}`);
      process.exit(1);
    }
  }

  if (manual && headless) {
    console.error('Cannot use --manual with --headless');
    process.exit(1);
  }

  console.log(`\n  Squarespace Design Settings Discovery`);
  console.log(`  Site: ${siteId} | Mode: ${manual ? 'MANUAL' : 'automated'} | Headless: ${headless}`);
  if (!manual && actionFilter) {
    console.log(`  Actions: ${actionFilter.join(', ')}`);
  } else if (!manual) {
    console.log('  Actions: both (font + color)');
  }
  console.log('');

  const browserManager = getBrowserManager({ headless: manual ? false : headless });

  try {
    // ── Setup ────────────────────────────────────────────────────────
    await browserManager.initialize();
    await ensureLoggedIn(browserManager);
    const page = await browserManager.getPage();

    // Discover sites and resolve config
    await discoverSites(page);
    const client = await resolveSite(siteId, page);
    console.log(`  Resolved site: ${client.name} (${client.site.adminUrl})\n`);

    await navigateToSite(page, client);

    // ── Network Capture ─────────────────────────────────────────────
    const capture = new NetworkCapture(page, {
      // Capture ALL requests — we're discovering unknown endpoints
      includePatterns: [/.*/],
    });

    const reports: ActionReport[] = [];

    if (manual) {
      // ── Manual Mode ─────────────────────────────────────────────
      const ctx: ActionContext = {
        siteSubdomain: client.site.adminUrl.match(/https:\/\/([^.]+)/)?.[1] ?? siteId,
      };

      // Navigate to Site Styles
      const stylesUrl = `https://${ctx.siteSubdomain}.squarespace.com/config/design/site-styles`;
      console.log(`  Navigating to: ${stylesUrl}`);
      await page.goto(stylesUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3000);

      console.log('\n' + '='.repeat(60));
      console.log('  MANUAL MODE — Network capture is active');
      console.log('='.repeat(60));
      console.log('');
      console.log('  The browser is open at Site Styles. You can now:');
      console.log('');
      console.log('  1. Click "Fonts" → change a heading/body font');
      console.log('  2. Click "Colors" → change a theme color');
      console.log('  3. Try Cmd+S or click Save/Done after each change');
      console.log('  4. Undo changes with Cmd+Z when done');
      console.log('');
      console.log('  All network traffic is being captured.');
      console.log('  Write endpoints (POST/PUT/PATCH) will be highlighted.');
      console.log('');

      const timeoutSec = parseInt(flags.timeout ?? '120', 10);
      console.log(`  Capture will run for ${timeoutSec} seconds.`);
      console.log('  Save after EACH change (font save, then color save).\n');

      // Start capture and wait
      capture.clear();
      await capture.start();
      const startMs = Date.now();

      let lastWriteCount = 0;

      // Live-log write requests as they happen
      const writeLogInterval = setInterval(() => {
        const requests = capture.getCapturedRequests();
        const writes = requests.filter(
          (r) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) && r.path.includes('/api/'),
        );
        if (writes.length > lastWriteCount) {
          // New write detected — log it fully
          for (let i = lastWriteCount; i < writes.length; i++) {
            const req = writes[i];
            const statusStr = req.responseStatus !== null ? `[${req.responseStatus}]` : '[pending]';
            const bodySize = req.requestBody ? JSON.stringify(req.requestBody).length : 0;
            console.log(`  WRITE: ${req.method} ${req.path} ${statusStr} (${bodySize} bytes)`);
          }
          lastWriteCount = writes.length;
        }
        const elapsed = Math.floor((Date.now() - startMs) / 1000);
        const remaining = timeoutSec - elapsed;
        if (remaining > 0 && remaining % 30 === 0) {
          process.stdout.write(`\r  ${remaining}s remaining...   `);
        }
      }, 1000);

      // Wait for timeout
      await new Promise((resolve) => setTimeout(resolve, timeoutSec * 1000));
      clearInterval(writeLogInterval);
      console.log('\n\n  Capture period ended.');

      capture.stop();
      const requests = capture.getCapturedRequests();
      const durationMs = Date.now() - startMs;

      reports.push({
        name: 'manual',
        label: 'Manual interaction — font + color changes',
        requests,
        durationMs,
      });

      console.log(`  Captured ${requests.length} request(s) in ${(durationMs / 1000).toFixed(1)}s`);

      // Immediately show write operations
      const writeOps = requests.filter(
        (r) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method),
      );
      if (writeOps.length > 0) {
        console.log(`\n  Write operations captured (${writeOps.length}):`);
        for (const req of writeOps) {
          const statusStr = req.responseStatus !== null ? `[${req.responseStatus}]` : '';
          const bodySize = req.requestBody ? JSON.stringify(req.requestBody).length : 0;
          console.log(`    ${req.method.padEnd(7)} ${req.path} ${statusStr} (${bodySize} bytes)`);
        }
      } else {
        console.log('\n  No write operations captured. Did you save your changes?');
      }
    } else {
      // ── Automated Mode ──────────────────────────────────────────
      const actions = buildDiscoveryActions();
      const ctx: ActionContext = {
        siteSubdomain: client.site.adminUrl.match(/https:\/\/([^.]+)/)?.[1] ?? siteId,
      };

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
    }

    // ── Build endpoint catalog ──────────────────────────────────────
    const catalog = buildEndpointCatalog(reports);

    // ── Save full capture to JSON ───────────────────────────────────
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outputPath = join(process.cwd(), 'data', `design-settings-discovery-${timestamp}.json`);

    const output = {
      capturedAt: new Date().toISOString(),
      siteId,
      mode: manual ? 'manual' : 'automated',
      crumbToken: capture.getCrumbToken(),
      summary: {
        totalActions: reports.length,
        totalRequests: reports.reduce((s, r) => s + r.requests.length, 0),
        uniqueEndpoints: catalog.length,
        writeEndpoints: catalog.filter((e) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(e.method)).length,
        actionsWithErrors: reports.filter((r) => r.error).length,
      },
      hypothesis: {
        description: 'Design settings save via /api/template/Save* or /api/config/Save* endpoints',
        templateSaveFound: catalog.some((e) => /\/api\/template\/Save/i.test(e.path)),
        configSaveFound: catalog.some((e) => /\/api\/config\/Save/i.test(e.path)),
        designRelatedEndpoints: catalog
          .filter((e) => /\/api\/(template|config|design|style|font|color|tweak)/i.test(e.path))
          .map((e) => `${e.method} ${e.path}`),
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

    // ── Print report ────────────────────────────────────────────────
    printReport(reports, catalog, siteId);

    // ── Cleanup ─────────────────────────────────────────────────────
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
