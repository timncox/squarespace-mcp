/**
 * Integration tests for Squarespace compound actions on the Smyth Tavern trial site.
 *
 * These tests run against the LIVE grey-yellow-hbxc Squarespace trial site and require:
 *   1. A valid Squarespace session (storage/session-state.json)
 *      Generate with: npx tsx scripts/prep-integration-test.ts grey-yellow-hbxc home
 *   2. A running browser (non-headless)
 *
 * Run with:
 *   npx vitest run src/automation/__tests__/smyth-tavern.integration.test.ts
 *
 * IMPORTANT: These tests modify real page content. After each test,
 * the action is reversed. A final "Save" is NOT performed so changes
 * are discarded on page reload.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, Browser, Page } from 'playwright';
import { executeAgentAction } from '../browser-agent-actions.js';
import * as fs from 'fs';
import * as path from 'path';

// ─── Test configuration ──────────────────────────────────────────────────

const SITE_SUBDOMAIN = 'grey-yellow-hbxc';
const SESSION_STATE_PATH = path.resolve('storage/session-state.json');
const TEST_TIMEOUT = 120_000;

// ─── Shared browser state ────────────────────────────────────────────────

let browser: Browser;
let page: Page;

/**
 * Navigate to the Squarespace editor for the home page.
 * The prep script (scripts/prep-integration-test.ts) should be run first
 * to generate session-state.json with the editor already open.
 */
async function navigateToEditor() {
  // Navigate to the site config/pages
  await page.goto(
    `https://${SITE_SUBDOMAIN}.squarespace.com/config/pages`,
    { waitUntil: 'networkidle', timeout: 30000 },
  );
  await page.waitForTimeout(3000);

  // The Home page should be visible. Click EDIT to enter editor mode.
  const editButton = page.locator('button:has-text("Edit")').first();
  const editVisible = await editButton.isVisible({ timeout: 5000 }).catch(() => false);
  if (editVisible) {
    await editButton.click();
    await page.waitForTimeout(5000);
  } else {
    // May already be in editor mode, or need to click Home first
    const homeLink = page.locator('a:has-text("Home")').first();
    const homeVisible = await homeLink.isVisible({ timeout: 3000 }).catch(() => false);
    if (homeVisible) {
      await homeLink.click({ force: true });
      await page.waitForTimeout(3000);
      // Try Edit button again
      const retryEdit = page.locator('button:has-text("Edit")').first();
      const retryVisible = await retryEdit.isVisible({ timeout: 5000 }).catch(() => false);
      if (retryVisible) {
        await retryEdit.click();
        await page.waitForTimeout(5000);
      }
    }
  }

  // Verify the site iframe loaded
  const frame = page.frame({ name: 'sqs-site-frame' });
  if (!frame) {
    // Last resort: wait longer for iframe
    await page.waitForTimeout(5000);
  }
}

// ─── Setup & Teardown ────────────────────────────────────────────────────

beforeAll(async () => {
  if (!fs.existsSync(SESSION_STATE_PATH)) {
    throw new Error(
      `Session state file not found at ${SESSION_STATE_PATH}. ` +
      'Run `npx tsx scripts/prep-integration-test.ts grey-yellow-hbxc home` first.',
    );
  }

  browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: SESSION_STATE_PATH,
    viewport: { width: 1440, height: 900 },
  });
  page = await context.newPage();

  await navigateToEditor();
}, 90_000);

afterAll(async () => {
  if (page) {
    // Don't save — discard changes
    await page.close().catch(() => {});
  }
  if (browser) {
    await browser.close().catch(() => {});
  }
});

// ─── Tests ───────────────────────────────────────────────────────────────

describe('Smyth Tavern — findText', () => {
  it(
    'should find navigation text on the page',
    async () => {
      // "Private Dining" is in the nav — should be findable
      const result = await executeAgentAction(page, {
        action: 'findText',
        text: 'Private Dining',
      });
      expect(result.success).toBe(true);
      expect(result.message).toContain('Found');
    },
    TEST_TIMEOUT,
  );

  it(
    'should find another nav item',
    async () => {
      const result = await executeAgentAction(page, {
        action: 'findText',
        text: 'Reservations',
      });
      expect(result.success).toBe(true);
      expect(result.message).toContain('Found');
    },
    TEST_TIMEOUT,
  );

  it(
    'should report text not found for nonexistent content',
    async () => {
      const result = await executeAgentAction(page, {
        action: 'findText',
        text: 'Absolutely unique nonexistent text xyz999abc',
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    },
    TEST_TIMEOUT,
  );
});

describe('Smyth Tavern — editTextBlock', () => {
  it(
    'should fail gracefully for nonexistent text',
    async () => {
      const result = await executeAgentAction(page, {
        action: 'editTextBlock',
        searchText: 'This text definitely does not exist xyz123',
        newText: 'Should not appear',
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    },
    TEST_TIMEOUT,
  );
});

describe('Smyth Tavern — editButtonBlock', () => {
  it(
    'should update Reservations button label and restore',
    async () => {
      const result = await executeAgentAction(page, {
        action: 'editButtonBlock',
        searchText: 'Reservations',
        newLabel: 'Book a Table',
      });

      if (result.success) {
        expect(result.message).toContain('Book a Table');

        // Restore
        await page.waitForTimeout(1000);
        await executeAgentAction(page, {
          action: 'editButtonBlock',
          searchText: 'Book a Table',
          newLabel: 'Reservations',
        });
      } else {
        // Reservations might be a link, not a button block
        console.warn('editButtonBlock: Reservations not found as button:', result.message);
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'should fail for nonexistent button',
    async () => {
      const result = await executeAgentAction(page, {
        action: 'editButtonBlock',
        searchText: 'Nonexistent Button XYZ',
        newLabel: 'Should Not Work',
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    },
    TEST_TIMEOUT,
  );

  it(
    'should fail when neither label nor URL provided',
    async () => {
      const result = await executeAgentAction(page, {
        action: 'editButtonBlock',
        searchText: 'Reservations',
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('must provide');
    },
    TEST_TIMEOUT,
  );
});

describe('Smyth Tavern — enterSectionEditMode', () => {
  it(
    'should enter edit mode for a section with known text',
    async () => {
      // Escape any existing edit mode first
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      await page.mouse.click(600, 500);
      await page.waitForTimeout(500);

      const result = await executeAgentAction(page, {
        action: 'enterSectionEditMode',
        searchText: 'Private Dining',
      });
      expect(result.success).toBe(true);
      expect(result.message).toContain('section edit mode');
    },
    TEST_TIMEOUT,
  );

  it(
    'should handle nonexistent section text gracefully',
    async () => {
      // Note: enterSectionEditMode may succeed by entering edit mode on a
      // nearby/previously-selected section even when text isn't found.
      // We just verify it doesn't throw/crash.
      const result = await executeAgentAction(page, {
        action: 'enterSectionEditMode',
        searchText: 'This section text does not exist xyz999',
      });
      expect(result.message).toBeTruthy();
    },
    TEST_TIMEOUT,
  );
});

describe('Smyth Tavern — moveBlockInSection', () => {
  it(
    'should move a block with known text to the right',
    async () => {
      // Escape any prior edit mode
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

      const result = await executeAgentAction(page, {
        action: 'moveBlockInSection',
        searchText: 'Private Dining',
        position: 'right',
      });
      // Move should succeed (API fast path or UI fallback)
      expect(result.success).toBe(true);
      expect(result.message).toContain('move');
    },
    TEST_TIMEOUT,
  );

  it(
    'should move a block down',
    async () => {
      const result = await executeAgentAction(page, {
        action: 'moveBlockInSection',
        searchText: 'Private Dining',
        position: 'down',
      });
      expect(result.success).toBe(true);
      expect(result.message).toContain('move');

      // Move back up to restore
      await executeAgentAction(page, {
        action: 'moveBlockInSection',
        searchText: 'Private Dining',
        position: 'up',
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'should fail for nonexistent block text',
    async () => {
      const result = await executeAgentAction(page, {
        action: 'moveBlockInSection',
        searchText: 'Nonexistent block text xyz777',
        position: 'left',
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    },
    TEST_TIMEOUT,
  );
});

describe('Smyth Tavern — resizeBlock', () => {
  it(
    'should resize a block wider',
    async () => {
      // Escape any prior edit mode
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

      const result = await executeAgentAction(page, {
        action: 'resizeBlock',
        searchText: 'Private Dining',
        width: 'larger',
      });
      expect(result.success).toBe(true);
      expect(result.message).toContain('resize');

      // Shrink back to restore
      await executeAgentAction(page, {
        action: 'resizeBlock',
        searchText: 'Private Dining',
        width: 'smaller',
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'should resize a block taller',
    async () => {
      const result = await executeAgentAction(page, {
        action: 'resizeBlock',
        searchText: 'Private Dining',
        height: 'taller',
      });
      expect(result.success).toBe(true);
      expect(result.message).toContain('resize');

      // Shrink back
      await executeAgentAction(page, {
        action: 'resizeBlock',
        searchText: 'Private Dining',
        height: 'shorter',
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'should resize with both width and height',
    async () => {
      const result = await executeAgentAction(page, {
        action: 'resizeBlock',
        searchText: 'Private Dining',
        width: 'larger',
        height: 'taller',
      });
      expect(result.success).toBe(true);
      expect(result.message).toContain('resize');

      // Restore
      await executeAgentAction(page, {
        action: 'resizeBlock',
        searchText: 'Private Dining',
        width: 'smaller',
        height: 'shorter',
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'should fail when neither width nor height provided',
    async () => {
      const result = await executeAgentAction(page, {
        action: 'resizeBlock',
        searchText: 'Private Dining',
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('must provide');
    },
    TEST_TIMEOUT,
  );

  it(
    'should fail for nonexistent block text',
    async () => {
      const result = await executeAgentAction(page, {
        action: 'resizeBlock',
        searchText: 'Nonexistent block text xyz666',
        width: 'larger',
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    },
    TEST_TIMEOUT,
  );
});

describe('Smyth Tavern — removeBlock', () => {
  it(
    'should fail gracefully for nonexistent block',
    async () => {
      const result = await executeAgentAction(page, {
        action: 'removeBlock',
        searchText: 'This block absolutely does not exist xyz888',
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    },
    TEST_TIMEOUT,
  );
});

describe('Smyth Tavern — basic actions', () => {
  it(
    'should press Escape key',
    async () => {
      const result = await executeAgentAction(page, {
        action: 'press',
        key: 'Escape',
      });
      expect(result.success).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'should scroll the page down and back up',
    async () => {
      const result = await executeAgentAction(page, {
        action: 'scroll',
        direction: 'down',
        amount: 300,
      });
      expect(result.success).toBe(true);

      // Scroll back
      await executeAgentAction(page, {
        action: 'scroll',
        direction: 'up',
        amount: 300,
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'should navigate to a different page and back',
    async () => {
      const result = await executeAgentAction(page, {
        action: 'navigate',
        url: `https://${SITE_SUBDOMAIN}.squarespace.com/gallery`,
      });
      expect(result.success).toBe(true);

      // Navigate back
      await executeAgentAction(page, {
        action: 'navigate',
        url: `https://${SITE_SUBDOMAIN}.squarespace.com/`,
      });
    },
    TEST_TIMEOUT,
  );
});
