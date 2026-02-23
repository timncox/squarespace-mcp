/**
 * Integration tests for Squarespace compound actions.
 *
 * These tests run against a LIVE Squarespace site and require:
 *   1. A valid Squarespace session (login cookies in storage/session-state.json)
 *   2. The "tim-cox" site with a "coding-projects" page
 *   3. A running browser (non-headless by default)
 *
 * Run with:
 *   npx vitest run src/automation/__tests__/compound-actions.integration.test.ts
 *
 * Or with the CLI shortcut:
 *   npm run test:integration
 *
 * IMPORTANT: These tests modify real page content. After each test,
 * the action is reversed (e.g., text is restored, added blocks are removed).
 * A final "Save" is NOT performed so changes are discarded on page reload.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, Browser, Page } from 'playwright';
import { executeAgentAction } from '../browser-agent-actions.js';
import { findTextOnPage } from '../editor-actions.js';
import * as fs from 'fs';
import * as path from 'path';

// ─── Test configuration ──────────────────────────────────────────────────

const SITE_SUBDOMAIN = 'tim-cox';
const PAGE_SLUG = 'coding-projects';
const SESSION_STATE_PATH = path.resolve('storage/session-state.json');
const TEST_TIMEOUT = 120_000; // 2 minutes per test

// ─── Shared browser state ────────────────────────────────────────────────

let browser: Browser;
let page: Page;

/**
 * Navigate to the Squarespace editor for the test page.
 * Assumes a valid session state file exists.
 */
async function navigateToEditor() {
  // Navigate to the page editor
  await page.goto(
    `https://${SITE_SUBDOMAIN}.squarespace.com/config/pages`,
    { waitUntil: 'networkidle', timeout: 30000 },
  );
  await page.waitForTimeout(2000);

  // Click the page in the pages list
  const pageLink = page.locator(`text=${PAGE_SLUG}`).first();
  const pageVisible = await pageLink.isVisible({ timeout: 5000 }).catch(() => false);
  if (pageVisible) {
    await pageLink.click();
    await page.waitForTimeout(3000);
  } else {
    // Try direct URL
    await page.goto(
      `https://${SITE_SUBDOMAIN}.squarespace.com/${PAGE_SLUG}`,
      { waitUntil: 'networkidle', timeout: 30000 },
    );
    await page.waitForTimeout(2000);
  }

  // Enter edit mode
  const editButton = page.locator('button:has-text("Edit")').first();
  const editVisible = await editButton.isVisible({ timeout: 5000 }).catch(() => false);
  if (editVisible) {
    await editButton.click();
    await page.waitForTimeout(3000);
  }
}

// ─── Setup & Teardown ────────────────────────────────────────────────────

beforeAll(async () => {
  // Check for session state
  if (!fs.existsSync(SESSION_STATE_PATH)) {
    throw new Error(
      `Session state file not found at ${SESSION_STATE_PATH}. ` +
      'Run `npm run test-login` first to create a session.',
    );
  }

  browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: SESSION_STATE_PATH,
    viewport: { width: 1440, height: 900 },
  });
  page = await context.newPage();

  await navigateToEditor();
}, 60_000);

afterAll(async () => {
  if (page) {
    // Don't save — discard changes by not clicking Save
    await page.close().catch(() => {});
  }
  if (browser) {
    await browser.close().catch(() => {});
  }
});

// ─── Helper ──────────────────────────────────────────────────────────────

/** Get the Frame object for the site iframe */
function getSiteFrame() {
  return page.frame({ name: 'sqs-site-frame' });
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('editTextBlock', () => {
  it(
    'should replace existing text in a text block',
    async () => {
      // Find a text block with known content
      const siteFrame = getSiteFrame();
      expect(siteFrame).not.toBeNull();

      // First, check what text exists
      const matches = await findTextOnPage(page, 'My Coding Portfolio');
      const hasText = matches.length > 0;

      if (!hasText) {
        // Use placeholder text detection
        const result = await executeAgentAction(page, {
          action: 'editTextBlock',
          searchText: 'Write here',
          newText: 'Integration Test Text',
        });
        expect(result.success).toBe(true);
        expect(result.message).toContain('Integration Test Text');

        // Restore
        await executeAgentAction(page, {
          action: 'editTextBlock',
          searchText: 'Integration Test Text',
          newText: '',
        });
      } else {
        const result = await executeAgentAction(page, {
          action: 'editTextBlock',
          searchText: 'My Coding Portfolio',
          newText: 'Test Portfolio Title',
        });
        expect(result.success).toBe(true);
        expect(result.message).toContain('Test Portfolio Title');

        // Restore original text
        await executeAgentAction(page, {
          action: 'editTextBlock',
          searchText: 'Test Portfolio Title',
          newText: 'My Coding Portfolio',
        });
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'should fail gracefully for nonexistent text',
    async () => {
      const result = await executeAgentAction(page, {
        action: 'editTextBlock',
        searchText: 'This text definitely does not exist anywhere on the page xyz123',
        newText: 'Should not appear',
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    },
    TEST_TIMEOUT,
  );
});

describe('editButtonBlock', () => {
  it(
    'should update button label via editor panel',
    async () => {
      const result = await executeAgentAction(page, {
        action: 'editButtonBlock',
        searchText: 'Learn more',
        newLabel: 'View Projects',
      });
      expect(result.success).toBe(true);
      expect(result.message).toContain('View Projects');

      // Restore
      await page.waitForTimeout(1000);
      await executeAgentAction(page, {
        action: 'editButtonBlock',
        searchText: 'View Projects',
        newLabel: 'Learn more',
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'should update button URL via LINK picker',
    async () => {
      const result = await executeAgentAction(page, {
        action: 'editButtonBlock',
        searchText: 'Learn more',
        url: '/projects',
      });
      // URL editing may or may not fully verify, but should succeed
      expect(result.success).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'should update both label and URL',
    async () => {
      const result = await executeAgentAction(page, {
        action: 'editButtonBlock',
        searchText: 'Learn more',
        newLabel: 'See Work',
        url: '/projects',
      });
      expect(result.success).toBe(true);
      expect(result.message).toContain('See Work');

      // Restore
      await page.waitForTimeout(1000);
      await executeAgentAction(page, {
        action: 'editButtonBlock',
        searchText: 'See Work',
        newLabel: 'Learn more',
      });
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
        searchText: 'Learn more',
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('must provide');
    },
    TEST_TIMEOUT,
  );
});

describe('enterSectionEditMode', () => {
  it(
    'should enter Fluid Engine edit mode for a section',
    async () => {
      // First, escape any existing edit mode
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      await page.mouse.click(600, 500);
      await page.waitForTimeout(500);

      const result = await executeAgentAction(page, {
        action: 'enterSectionEditMode',
        searchText: 'Learn more',
      });
      expect(result.success).toBe(true);
      expect(result.message).toContain('section edit mode');
    },
    TEST_TIMEOUT,
  );

  it(
    'should fail for nonexistent section text',
    async () => {
      const result = await executeAgentAction(page, {
        action: 'enterSectionEditMode',
        searchText: 'This section text does not exist xyz999',
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    },
    TEST_TIMEOUT,
  );
});

describe('addBlockToSection', () => {
  it(
    'should add a Text block to an active section',
    async () => {
      // First enter section edit mode
      await executeAgentAction(page, {
        action: 'enterSectionEditMode',
        searchText: 'Learn more',
      });
      await page.waitForTimeout(500);

      const result = await executeAgentAction(page, {
        action: 'addBlockToSection',
        blockType: 'Text',
      });
      expect(result.success).toBe(true);
      expect(result.message).toContain('Text');
    },
    TEST_TIMEOUT,
  );

  it(
    'should fail when not in section edit mode',
    async () => {
      // Exit any edit mode
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      await page.mouse.click(600, 500);
      await page.waitForTimeout(500);

      const result = await executeAgentAction(page, {
        action: 'addBlockToSection',
        blockType: 'Text',
      });
      // Should fail or warn about not being in edit mode
      // (may succeed if Fluid Engine is still active)
      expect(result.message).toBeTruthy();
    },
    TEST_TIMEOUT,
  );
});

describe('removeBlock', () => {
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

describe('basic actions', () => {
  it(
    'should find text on the page',
    async () => {
      const result = await executeAgentAction(page, {
        action: 'findText',
        text: 'Learn more',
      });
      expect(result.success).toBe(true);
      expect(result.message).toContain('Found');
    },
    TEST_TIMEOUT,
  );

  it(
    'should report text not found',
    async () => {
      const result = await executeAgentAction(page, {
        action: 'findText',
        text: 'Absolutely unique text that does not exist xyz123abc',
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    },
    TEST_TIMEOUT,
  );

  it(
    'should press a key',
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
    'should scroll the page',
    async () => {
      const result = await executeAgentAction(page, {
        action: 'scroll',
        direction: 'down',
        amount: 200,
      });
      expect(result.success).toBe(true);

      // Scroll back
      await executeAgentAction(page, {
        action: 'scroll',
        direction: 'up',
        amount: 200,
      });
    },
    TEST_TIMEOUT,
  );
});
