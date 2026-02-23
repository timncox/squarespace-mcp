import { Page } from 'playwright';
import type { BrowserHandle } from '../browser-manager.js';
import { ensureLoggedIn } from '../squarespace-auth.js';
import { navigateToSite, navigateToPage, enterEditMode, resolveSite } from '../site-navigator.js';
import { findAndDeleteContent } from '../editor-actions.js';
import { takeScreenshot } from '../../utils/screenshot.js';
import { logger } from '../../utils/logger.js';
import type { ActionResult } from '../../models/task.js';
import { errMsg } from '../../utils/errors.js';

export interface RemoveContentParams {
  siteIdentifier: string;
  pageSlug: string;
  contentToFind: string;
}

/**
 * Remove content from a specific page on a Squarespace site.
 *
 * Flow:
 * 1. Resolve the site from the identifier
 * 2. Navigate to the site admin
 * 3. Navigate to the target page
 * 4. Enter edit mode
 * 5. Find the content text on the page
 * 6. Select and delete the block containing it
 * 7. Take a screenshot (page is left in unsaved edit state)
 */
export async function removeContent(
  browserManager: BrowserHandle,
  params: RemoveContentParams,
): Promise<ActionResult> {
  const { siteIdentifier, pageSlug, contentToFind } = params;

  logger.info({ siteIdentifier, pageSlug, contentToFind }, 'Starting remove content action');

  try {
    // Ensure logged in
    await ensureLoggedIn(browserManager);

    const page = await browserManager.getPage();
    const client = await resolveSite(siteIdentifier, page);

    // Navigate to the site
    await navigateToSite(page, client);

    // Navigate to the target page
    await navigateToPage(page, client, pageSlug);

    // Enter edit mode
    await enterEditMode(page);

    // Find and delete the content
    const result = await findAndDeleteContent(page, contentToFind);

    if (!result.found) {
      return {
        success: false,
        error: `Content "${contentToFind}" not found on page "${pageSlug}"`,
        screenshotPath: result.screenshotPath,
      };
    }

    // Take final screenshot showing the edit is ready
    const screenshotPath = await takeScreenshot(page, `removed-${siteIdentifier}-${pageSlug}`);

    logger.info({ siteIdentifier, pageSlug, contentToFind }, 'Content removed successfully');

    return {
      success: true,
      screenshotPath,
    };
  } catch (err) {
    const errorMessage = errMsg(err);
    logger.error({ siteIdentifier, pageSlug, contentToFind, error: errorMessage }, 'Remove content failed');

    // Try to take an error screenshot
    let screenshotPath: string | undefined;
    try {
      const page = await browserManager.getPage();
      screenshotPath = await takeScreenshot(page, 'remove-error');
    } catch {
      // Can't take screenshot
    }

    return {
      success: false,
      error: errorMessage,
      screenshotPath,
    };
  }
}
