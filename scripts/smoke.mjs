// Endpoint-drift smoke test: run the core READ methods against a real site
// and flag errors or suspiciously-empty payloads. Squarespace changes its
// internal APIs under this server (2026-07-08: /api/settings stopped carrying
// injection values; SaveInjectionSettings silently ignored old field names) —
// run this whenever the MCP acts strange, BEFORE debugging tool code.
//
// Run: node scripts/smoke.mjs [subdomain]   (default: tim-cox)
// Requires a valid session — run scripts/relogin.mjs first if this 401s.
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.SESSION_DIR = process.env.SESSION_DIR ?? join(ROOT, 'storage', 'auth');
process.env.SITES_CONFIG = process.env.SITES_CONFIG ?? join(ROOT, 'config', 'sites.json');
process.env.DB_PATH = process.env.DB_PATH ?? join(ROOT, 'data', 'sqhelper.db');

const SUB = process.argv[2] ?? 'tim-cox';

const { getClient, listSites } = await import(join(ROOT, 'dist/src/mcp-server/session.js'));

const results = [];
function report(name, ok, note) {
  results.push({ name, ok, note });
  console.log(`${ok ? '  ok ' : 'DRIFT'}  ${name}${note ? ` — ${note}` : ''}`);
}

try {
  const sites = await listSites();
  report('listSites', sites.length > 0, `${sites.length} sites`);
} catch (e) {
  report('listSites', false, e.message?.slice(0, 120));
}

const client = getClient(SUB);
const checks = [
  ['getSettings', async () => {
    const r = await client.getSettings();
    if (!r.success) throw new Error(r.error);
    const keys = Object.keys(r.data ?? r.settings ?? {}).length;
    return { empty: keys === 0, note: `${keys} keys` };
  }],
  ['getCodeInjection', async () => {
    const r = await client.getCodeInjection();
    if (!r.success) throw new Error(r.error);
    return { empty: false, note: `header ${r.data.header.length}ch, footer ${r.data.footer.length}ch` };
  }],
  ['getSiteIdentity', async () => {
    const r = await client.getSiteIdentity();
    if (!r.success) throw new Error(r.error);
    return { empty: !r.data, note: r.data?.siteTitle ?? '' };
  }],
  ['getCustomCSS', async () => {
    const r = await client.getCustomCSS();
    if (!r.success) throw new Error(r.error);
    return { empty: false, note: `${r.css.length}ch css` };
  }],
  ['getNavigation', async () => {
    const r = await client.getNavigation();
    if (!r.success) throw new Error(r.error ?? 'no success flag');
    return { empty: false, note: 'ok' };
  }],
  ['getSocialAccounts', async () => {
    const r = await client.getSocialAccounts();
    if (!r.success) throw new Error(r.error);
    return { empty: false, note: `${(r.data ?? []).length} accounts` };
  }],
];

for (const [name, fn] of checks) {
  try {
    const { empty, note } = await fn();
    report(name, !empty, note);
  } catch (e) {
    report(name, false, String(e.message ?? e).slice(0, 160));
  }
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} reads healthy on ${SUB}`);
if (bad.length) {
  console.log('Suspect endpoint drift or expired session. If ALL fail with 401 → run scripts/relogin.mjs.');
  process.exit(1);
}
