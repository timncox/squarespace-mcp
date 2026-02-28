/**
 * Quick snapshot of a page's sections via Content Save API.
 *
 * Usage (named flags — resolves page slug via HTML fetch):
 *   npx tsx scripts/snapshot-page.ts --site grey-yellow-hbxc --page test-page --output data/snapshot.json
 *
 * Usage (positional args — provide pageSectionsId directly):
 *   npx tsx scripts/snapshot-page.ts [site-id] [pageSectionsId] [output-file]
 */
import { createContentSaveClient } from '../src/services/content-save.js';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Resolve a page slug to its pageSectionsId by fetching the page HTML with
 * authenticated session cookies and extracting the data-page-sections attribute.
 */
async function resolvePageSectionsId(
  siteId: string,
  pageSlug: string,
): Promise<string | null> {
  const sessionPath = join(process.cwd(), 'storage', 'auth', 'sqsp-session.json');
  if (!existsSync(sessionPath)) {
    console.error('Session file not found:', sessionPath);
    return null;
  }

  const session = JSON.parse(readFileSync(sessionPath, 'utf-8')) as { cookies: Array<{ name: string; value: string; domain: string }> };
  const cookieHeader = session.cookies
    .filter((c) => c.domain.includes(siteId) || c.domain.includes('squarespace.com'))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  const pageUrl = `https://${siteId}.squarespace.com/${pageSlug === 'home' ? '' : pageSlug}`;
  console.log(`Fetching page HTML from: ${pageUrl}`);

  try {
    const response = await fetch(pageUrl, {
      headers: {
        Cookie: cookieHeader,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      },
    });

    if (!response.ok) {
      console.error(`Failed to fetch page (${response.status})`);
      return null;
    }

    const html = await response.text();
    const match = html.match(/data-page-sections="([a-f0-9]+)"/);
    if (!match) {
      console.error('Could not find data-page-sections attribute in page HTML');
      return null;
    }

    return match[1];
  } catch (err) {
    console.error('Error fetching page:', err);
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const getFlag = (flag: string) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };
  const hasFlags = args.some((a) => a.startsWith('--'));

  let siteId: string;
  let psId: string;
  let outFile: string;

  if (hasFlags) {
    siteId = getFlag('--site') ?? 'grey-yellow-hbxc';
    const pageSlug = getFlag('--page');
    outFile = getFlag('--output') ?? 'storage/recordings/snapshot.json';

    if (!pageSlug) {
      console.error('--page <slug> is required when using named flags');
      process.exit(1);
    }

    console.log(`Resolving pageSectionsId for page: ${pageSlug}`);
    const resolved = await resolvePageSectionsId(siteId, pageSlug);
    if (!resolved) {
      console.error('Could not resolve pageSectionsId. Provide it directly as positional arg instead.');
      process.exit(1);
    }
    psId = resolved;
    console.log(`  → pageSectionsId: ${psId}`);
  } else {
    siteId = args[0] ?? 'grey-yellow-hbxc';
    psId = args[1] ?? '6993497ab23b0453e46b65aa';
    outFile = args[2] ?? 'storage/recordings/snapshot.json';
  }

  mkdirSync(outFile.replace(/\/[^\/]+$/, ''), { recursive: true });

  const client = createContentSaveClient(siteId);
  const sections = await client.getPageSections(psId);

  writeFileSync(outFile, JSON.stringify(sections, null, 2));
  console.log(`Saved ${sections.sections.length} sections to ${outFile}`);

  for (let i = 0; i < sections.sections.length; i++) {
    const s = sections.sections[i];
    const blocks = s.fluidEngineContext?.gridContents?.length ?? 0;
    console.log(`  Section ${i}: ${blocks} blocks (${s.id?.substring(0, 8)}...)`);
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
