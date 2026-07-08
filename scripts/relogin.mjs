// Re-authenticate the Squarespace MCP session non-interactively.
//
// Opens headful Chrome, auto-fills SQSP_EMAIL/SQSP_PASSWORD from .env, waits
// for login (rescue CAPTCHA/2FA manually in the window if one appears), then
// visits every site's /config so the cookie jar collects per-site
// member-session + crumb cookies — the Content API 401s without them — and
// writes the full storageState as storage/auth/sqsp-session.json.
//
// Why not saveSessionAndDiscoverSites: its captureSiteCookies endpoint only
// returns member-session cookies (never per-site crumbs), and it has a
// concurrent read-modify-write race on the session file. Real browser
// navigation is the only capture path verified to produce a working session
// (2026-07-08).
//
// Run: node scripts/relogin.mjs                (all sites, ~1.5 min)
//      node scripts/relogin.mjs <subdomain...> (only the named sites — faster,
//        but sites not visited keep their old, likely-expired cookies)
//      --headless : try without a visible window first. Squarespace currently
//        rejects headless logins (verified 2026-07-08), so this auto-falls
//        back to a visible window — the flag mostly future-proofs.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SESSION_PATH = join(ROOT, 'storage', 'auth', 'sqsp-session.json');

// Site list as of 2026-07-08 — update as sites are added to the account.
// (buttercup-pug-e574 = Maison Nur / www.maisonnur.nyc)
const ALL_SUBDOMAINS = [
  'buttercup-pug-e574',
  'smyth-tavern', 'bmco', 'tim-cox', 'lurefishbar', 'ruby-iris-ferj',
  'goldfish-harmonica-z7bh', 'jaguar-koi-4kxs', 'sphere-green-b2j7',
  'seahorsenyc', 'msh', 'buttercup-bell-9mx7',
];
const args = process.argv.slice(2);
const HEADLESS = args.includes('--headless');
const named = args.filter((a) => !a.startsWith('--'));
const SUBDOMAINS = named.length > 0 ? named : ALL_SUBDOMAINS;

const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
if (!env.SQSP_EMAIL || !env.SQSP_PASSWORD) {
  console.error('SQSP_EMAIL / SQSP_PASSWORD missing from .env');
  process.exit(2);
}

const { chromium } = await import('playwright');

// Attempt a full login in the given mode. Returns {browser, context, page}
// on success, or null after closing the browser on failure.
// NOTE: verified 2026-07-08 that Squarespace REJECTS headless logins (form
// submits, member-session never granted) — headless is attempted only because
// that may change; the headful fallback is what actually works.
async function attemptLogin(headless) {
  let browser;
  try {
    browser = await chromium.launch({ headless, channel: 'chrome' });
  } catch {
    browser = await chromium.launch({ headless });
  }
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('https://login.squarespace.com', { waitUntil: 'domcontentloaded' });

    // Best-effort auto-fill; any failure just leaves the window for manual login.
    try {
      const emailInput = page.locator('input[type="email"], input[name="email"]').first();
      await emailInput.waitFor({ timeout: 20000 });
      await emailInput.fill(env.SQSP_EMAIL);
      const pw = page.locator('input[type="password"]').first();
      if (!(await pw.isVisible().catch(() => false))) {
        await page
          .locator('button[type="submit"], button:has-text("Continue"), button:has-text("Log In")')
          .first()
          .click()
          .catch(() => {});
      }
      await pw.waitFor({ timeout: 20000 });
      await pw.fill(env.SQSP_PASSWORD);
      await page
        .locator('button[type="submit"], button:has-text("Log In"), button:has-text("Continue")')
        .first()
        .click()
        .catch(() => {});
      console.log(`login form submitted (${headless ? 'headless' : 'headful'})`);
    } catch (e) {
      console.log(`auto-fill incomplete (${e.message?.slice(0, 100)}); waiting for manual login`);
    }

    // Headless rejection fails fast; give humans/CAPTCHAs time in headful.
    const deadline = Date.now() + (headless ? 90_000 : 240_000);
    while (Date.now() < deadline) {
      const cookies = await context.cookies();
      if (cookies.some((c) => c.name === 'member-session')) {
        return { browser, context, page };
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log(`no member-session after ${headless ? 'headless' : 'headful'} attempt`);
  } catch (e) {
    console.log(`login attempt error: ${e.message?.slice(0, 120)}`);
  }
  await browser.close().catch(() => {});
  return null;
}

let browser;
try {
  let session = HEADLESS ? await attemptLogin(true) : null;
  if (HEADLESS && !session) {
    console.log('headless login blocked — retrying with a visible window');
  }
  if (!session) session = await attemptLogin(false);
  if (!session) {
    console.error('TIMEOUT: no member-session cookie — login not completed');
    process.exit(3);
  }
  browser = session.browser;
  const { context, page } = session;
  console.log('logged in; visiting site config pages…');

  await page.goto('https://account.squarespace.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2000);

  for (const sub of SUBDOMAINS) {
    try {
      await page.goto(`https://${sub}.squarespace.com/config/`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.waitForTimeout(2500);
      const cs = await context.cookies(`https://${sub}.squarespace.com`);
      const has = (n) => (cs.some((c) => c.name === n) ? 'y' : 'N');
      console.log(`${sub}: member-session=${has('member-session')} crumb=${has('crumb')}`);
    } catch (e) {
      console.log(`${sub}: visit failed — ${e.message?.slice(0, 80)}`);
    }
  }

  const fullState = await context.storageState();
  if (existsSync(SESSION_PATH)) copyFileSync(SESSION_PATH, SESSION_PATH + '.bak');
  writeFileSync(SESSION_PATH, JSON.stringify(fullState, null, 2), 'utf-8');
  console.log(
    `SAVED ${fullState.cookies.length} cookies; crumb domains: ` +
      fullState.cookies.filter((c) => c.name === 'crumb').map((c) => c.domain).join(', '),
  );
} finally {
  if (browser) await browser.close().catch(() => {});
}
