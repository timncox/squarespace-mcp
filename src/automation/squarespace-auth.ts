import { Page } from 'playwright';
import { createInterface } from 'readline';
import type { BrowserHandle } from './browser-manager.js';
import { findElement } from './selectors.js';
import { takeScreenshot } from '../utils/screenshot.js';
import { logger } from '../utils/logger.js';

const LOGIN_URL = 'https://login.squarespace.com/';
const ACCOUNT_URL = 'https://account.squarespace.com/';

/** Prompt for input in the terminal (used for 2FA codes during MVP). */
function promptInTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Perform the full Squarespace login flow.
 * Squarespace shows email + password on the SAME page.
 * The LOG IN button is disabled until both fields are filled.
 */
export async function performLogin(
  browserManager: BrowserHandle,
): Promise<void> {
  const page = await browserManager.getPage();

  const email = process.env.SQSP_EMAIL;
  const password = process.env.SQSP_PASSWORD;

  if (!email || !password) {
    throw new Error('SQSP_EMAIL and SQSP_PASSWORD must be set in .env');
  }

  logger.info('Navigating to Squarespace login');
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 30000 });

  // Fill email
  const emailInput = await findElement(page, 'login.emailInput', { timeout: 5000 });
  await emailInput.fill(email);
  logger.info('Email entered');

  // Fill password (both fields are on the same page)
  const passwordInput = await findElement(page, 'login.passwordInput', { timeout: 5000 });
  await passwordInput.fill(password);
  logger.info('Password entered');

  // Wait for the LOG IN button to become enabled.
  // Squarespace's React form enables the button after both fields are filled.
  const loginBtn = await findElement(page, 'login.submitButton');

  // Wait for the button to become enabled (not disabled)
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('#login-button, [data-test="login-button"], button[type="submit"]');
      return btn && !(btn as HTMLButtonElement).disabled;
    },
    { timeout: 10000 },
  );
  logger.info('Login button enabled');

  await loginBtn.click();
  logger.info('Login button clicked');

  // Race: either we land on the account page, or a 2FA prompt appears.
  // We must NOT use waitForTimeout before waitForURL — the navigation may
  // complete during the wait, causing waitForURL to miss it entirely.
  const accountPagePromise = page
    .waitForURL('**/account/**', { timeout: 30000 })
    .then(() => 'account' as const);

  const twoFAPromise = page
    .locator('input[name="totp"], input[name="code"], input[placeholder*="code"]')
    .first()
    .waitFor({ state: 'visible', timeout: 30000 })
    .then(() => '2fa' as const);

  const result = await Promise.race([accountPagePromise, twoFAPromise]).catch(
    () => 'timeout' as const,
  );

  if (result === '2fa') {
    logger.info('2FA prompt detected');
    await handle2FA(page);
    // After 2FA, wait for account page
    await page.waitForURL('**/account/**', { timeout: 15000 });
  } else if (result === 'timeout') {
    // Fallback: check if we're already on the account page
    // (handles edge case where both promises rejected)
    if (!page.url().includes('account.squarespace.com')) {
      const screenshotPath = await takeScreenshot(page, 'login-failed');
      throw new Error(
        `Login failed — URL: ${page.url()}. Screenshot: ${screenshotPath}`,
      );
    }
  }
  // result === 'account' means direct success

  logger.info('Login successful');
  await browserManager.saveSession();
}

async function handle2FA(page: Page): Promise<void> {
  logger.warn('2FA is required');

  // For MVP, prompt in terminal. Later, this will ask via WhatsApp.
  const code = await promptInTerminal('Enter your Squarespace 2FA code: ');

  const twoFactorInput = await findElement(page, 'login.twoFactorInput');
  await twoFactorInput.fill(code);

  const submitBtn = await findElement(page, 'login.submitButton');
  await submitBtn.click();

  logger.info('2FA code submitted');
}

/**
 * Ensure we are logged in. Checks session validity, logs in if needed.
 */
export async function ensureLoggedIn(
  browserManager: BrowserHandle,
): Promise<void> {
  const isValid = await browserManager.isSessionValid();
  if (isValid) {
    logger.info('Already logged in');
    return;
  }

  logger.info('Session invalid — logging in');
  await performLogin(browserManager);
}
