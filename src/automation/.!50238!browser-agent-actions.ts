import { Page } from 'playwright';
import { existsSync } from 'fs';
import { logger } from '../utils/logger.js';
import {
  clickThroughOverlay,
  dblclickThroughOverlay,
  findTextOnPage,
  saveChanges,
  getSiteFrame,
  hoverBetweenSectionsInIframe,
  cdpHoverAtSectionBoundary,
  forceClickHiddenAddSection,
} from './editor-actions.js';
import { navigateToPage, enterEditMode } from './site-navigator.js';
import { errMsg } from '../utils/errors.js';

/**
 * Validate that an image file exists before attempting upload.
 * Returns an ActionResult with a clear error if the file is missing.
 */
function validateFileExists(filePath: string, actionName: string): ActionResult | null {
  if (!existsSync(filePath)) {
    return {
      success: false,
      message: `${actionName}: File not found at "${filePath}". Ensure the file was downloaded to storage/uploads/ before attempting upload.`,
    };
  }
  return null;
}

