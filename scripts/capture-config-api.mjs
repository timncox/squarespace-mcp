// Capture the API traffic behind any Squarespace config UI panel.
//
// This is the ground-truth tool for endpoint drift (see CLAUDE.md): when an
// MCP tool 400s or silently no-ops, the config UI is the reference client —
// capture what IT sends and diff against what the MCP client sends.
//
// Usage:
//   node scripts/capture-config-api.mjs <subdomain> <config-path> [--headful] [--wait <sec>]
//
//   node scripts/capture-config-api.mjs sphere-green-b2j7 /config/pages/announcement-bar
//     → headless: loads the panel, records read traffic + a screenshot + the
//       panel's visible controls, then exits after --wait (default 20s).
//
//   node scripts/capture-config-api.mjs sphere-green-b2j7 /config/pages/announcement-bar --headful --wait 300
//     → headful: drive the panel by hand (toggle, type, SAVE) while it records
//       every request. Ctrl+C (or the wait elapsing) saves the capture.
//
// Output: storage/captures/<subdomain><config-path dashes>-<epoch>.json
//   { finalUrl, screenshot, controls, calls: [{t, kind, method, url, status, postData, body}] }
//   Write requests (POST/PUT/PATCH/DELETE) keep FULL postData — that payload
//   is the thing you diff against the MCP client's payload.
//
// Session note: uses (and rewrites) storage/auth/sqsp-session.json. Browser
// use rotates the cookies; the rewritten storageState keeps the MCP session
// valid — do NOT kill the script before it saves, or run sq_relogin after.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SESSION_PATH = join(ROOT, 'storage', 'auth', 'sqsp-session.json');
const CAPTURE_DIR = join(ROOT, 'storage', 'captures');

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const [sub, configPath] = positional;
if (!sub || !configPath?.startsWith('/config')) {
  console.error('usage: node scripts/capture-config-api.mjs <subdomain> </config/...> [--headful] [--wait <sec>]');
  process.exit(2);
}
const HEADFUL = args.includes('--headful');
const waitIdx = args.indexOf('--wait');
const WAIT_SEC = waitIdx >= 0 ? Number(args[waitIdx + 1]) : 20;

const { chromium } = await import('playwright');
const rawState = JSON.parse(readFileSync(SESSION_PATH, 'utf8'));
rawState.cookies = rawState.cookies.filter((c) => c.domain && c.path); // drop malformed empty-value placeholders
const browser = await chromium.launch({ headless: !HEADFUL });
const context = await browser.newContext({ storageState: rawState, viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

const NOISE = /events\.|clanker|sentry|census|fullstory|location\.squarespace|insights\.squarespace/;
const calls = [];
page.on('request', (req) => {
  const url = req.url();
  if (!/\/api\//.test(url) || NOISE.test(url)) return;
  const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method());
  const pd = req.postData() ?? null;
  calls.push({
    t: Date.now(), kind: 'request', method: req.method(), url,
    postData: isWrite ? pd : pd?.slice(0, 2000) ?? null,
    csrfHeader: req.headers()['x-csrf-token'] ?? null,
  });
});
page.on('response', async (res) => {
  const url = res.url();
  const req = res.request();
  if (!/\/api\//.test(url) || NOISE.test(url)) return;
  const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method());
  let body = null;
  try { body = (await res.text()).slice(0, isWrite ? 20000 : 4000); } catch { /* stream gone */ }
  calls.push({ t: Date.now(), kind: 'response', status: res.status(), method: req.method(), url, body });
});

mkdirSync(CAPTURE_DIR, { recursive: true });
const stamp = Date.now();
const slug = `${sub}${configPath.replace(/\//g, '-')}-${stamp}`;
const outPath = join(CAPTURE_DIR, `${slug}.json`);
const shotPath = join(CAPTURE_DIR, `${slug}.png`);

let saved = false;
async function saveAndExit(code) {
  if (saved) return;
  saved = true;
  try {
    await page.screenshot({ path: shotPath }).catch(() => {});
    const controls = await page.evaluate(() => {
      const els = [...document.querySelectorAll('input, textarea, [contenteditable], button, [role="switch"]')];
      return els.filter((el) => el.offsetWidth || el.offsetHeight).slice(0, 60).map((el) => ({
        tag: el.tagName, type: el.getAttribute('type'), aria: el.getAttribute('aria-label'),
        text: (el.textContent || '').trim().slice(0, 60), editable: el.getAttribute('contenteditable'),
      }));
    }).catch(() => []);
    await context.storageState({ path: SESSION_PATH }); // keep MCP session valid
    writeFileSync(outPath, JSON.stringify({ finalUrl: page.url(), screenshot: shotPath, controls, calls }, null, 2));
    console.error(`saved ${calls.length} calls -> ${outPath}`);
  } finally {
    await browser.close().catch(() => {});
    process.exit(code);
  }
}
process.on('SIGINT', () => void saveAndExit(0));

const target = `https://${sub}.squarespace.com${configPath}`;
console.error(`capturing ${target} (${HEADFUL ? 'headful — drive the UI, Ctrl+C to finish' : 'headless read-capture'}, ${WAIT_SEC}s)`);
await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(WAIT_SEC * 1000);
await saveAndExit(0);
