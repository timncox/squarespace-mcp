import { Page } from 'playwright';
import { join } from 'path';
import { logger } from './logger.js';

const SCREENSHOTS_DIR = join(process.cwd(), 'storage', 'screenshots');

export async function takeScreenshot(
  page: Page,
  name: string,
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${name}-${timestamp}.png`;
  const filepath = join(SCREENSHOTS_DIR, filename);

  await page.screenshot({ path: filepath, fullPage: false });
  logger.info({ filepath }, 'Screenshot saved');
  return filepath;
}

export async function takeFullPageScreenshot(
  page: Page,
  name: string,
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${name}-${timestamp}.png`;
  const filepath = join(SCREENSHOTS_DIR, filename);

  await page.screenshot({ path: filepath, fullPage: true });
  logger.info({ filepath }, 'Full-page screenshot saved');
  return filepath;
}
