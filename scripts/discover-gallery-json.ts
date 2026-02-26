/**
 * Discovery script: Inspect image blocks (type 1337) and gallery blocks (type 3/52)
 * on a live Squarespace site via saved session cookies.
 *
 * Usage: npx tsx scripts/discover-gallery-json.ts [subdomain] [page-slug]
 *
 * Defaults: subdomain = "grey-yellow-hbxc", page-slug = "home"
 */
import { ContentSaveClient } from '../src/services/content-save.js';

const subdomain = process.argv[2] || 'grey-yellow-hbxc';
const pageSlug = process.argv[3] || 'home';

async function main() {
  console.log(`\n=== Gallery/Image Block Discovery ===`);
  console.log(`Site: ${subdomain}.squarespace.com`);
  console.log(`Page: /${pageSlug}\n`);

  const client = new ContentSaveClient(subdomain);
  client.loadSessionCookies();

  const siteUrl = `https://${subdomain}.squarespace.com`;
  const headers = (client as any).buildHeaders();

  // Step 1: Find pageSectionsId from the page HTML
  console.log('Fetching page HTML to find pageSectionsId...');
  const pageUrl = pageSlug === 'home' ? siteUrl : `${siteUrl}/${pageSlug}`;
  const pageResp = await fetch(pageUrl, { headers });

  if (!pageResp.ok) {
    console.error(`Page fetch failed: ${pageResp.status}`);
    return;
  }

  const html = await pageResp.text();
  const psMatch = html.match(/data-page-sections="([^"]+)"/);
  if (!psMatch) {
    console.error('Could not find data-page-sections attribute in HTML');
    console.log('Trying format=json-pretty fallback...');

    const jsonResp = await fetch(`${pageUrl}?format=json-pretty`, { headers });
    if (jsonResp.ok) {
      const jsonData = await jsonResp.json() as any;
      const psId = jsonData.collection?.pageSectionsId;
      if (psId) {
        console.log(`Found pageSectionsId via JSON: ${psId}`);
        await inspectSections(client, psId);
        return;
      }
    }
    console.error('Could not find pageSectionsId');
    return;
  }

  const pageSectionsId = psMatch[1];
  console.log(`pageSectionsId: ${pageSectionsId}\n`);

  await inspectSections(client, pageSectionsId);
}

async function inspectSections(client: ContentSaveClient, pageSectionsId: string) {
  const data = await client.getPageSections(pageSectionsId);
  const sections = data.sections || [];
  console.log(`Found ${sections.length} sections\n`);

  let imageCount = 0;
  let galleryCount = 0;

  for (let si = 0; si < sections.length; si++) {
    const section = sections[si] as any;
    const blocks = section.fluidEngineContext?.gridContents || [];

    console.log(`── Section ${si}: ${section.id?.substring(0, 12)} (${section.sectionName || 'unknown'}) — ${blocks.length} blocks`);

    for (let bi = 0; bi < blocks.length; bi++) {
      const block = blocks[bi];
      const content = block.content?.value;
      if (!content) continue;

      const type = content.type;
      const blockId = content.id;

      // Image blocks (type 1337)
      if (type === 1337) {
        imageCount++;
        console.log(`\n  📷 IMAGE BLOCK ${bi} (id: ${blockId})`);
        console.log(`  Type: ${type}`);
        console.log(`  Value keys: ${Object.keys(content.value || {}).join(', ')}`);
        console.log(`  Block-level keys: ${Object.keys(content).join(', ')}`);

        if (content.altText !== undefined) {
          console.log(`  altText: "${content.altText}"`);
        }

        const val = content.value;
        if (val) {
          console.log(`\n  Full value JSON:`);
          console.log(JSON.stringify(val, null, 4).split('\n').map((l: string) => `    ${l}`).join('\n'));
        }

        // Show layout
        if (block.layout) {
          console.log(`\n  Layout:`);
          console.log(`    Desktop: (${block.layout.desktop?.start?.x},${block.layout.desktop?.start?.y}) → (${block.layout.desktop?.end?.x},${block.layout.desktop?.end?.y})`);
          console.log(`    Mobile: (${block.layout.mobile?.start?.x},${block.layout.mobile?.start?.y}) → (${block.layout.mobile?.end?.x},${block.layout.mobile?.end?.y})`);
        }
        console.log('');
      }

      // Gallery blocks (type 3 or 52)
      if (type === 3 || type === 52) {
        galleryCount++;
        console.log(`\n  🖼️ GALLERY BLOCK ${bi} (id: ${blockId})`);
        console.log(`  Type: ${type}`);
        console.log(`  Block-level keys: ${Object.keys(content).join(', ')}`);

        const val = content.value;
        if (val) {
          console.log(`  Value keys: ${Object.keys(val).join(', ')}`);
          // Print full JSON but limit to 5000 chars
          const fullJson = JSON.stringify(val, null, 4);
          const lines = fullJson.split('\n').map((l: string) => `    ${l}`).join('\n');
          if (lines.length > 5000) {
            console.log(`\n  Full value JSON (first 5000 chars):`);
            console.log(lines.substring(0, 5000) + '\n    ... (truncated)');
          } else {
            console.log(`\n  Full value JSON:`);
            console.log(lines);
          }
        }
        console.log('');
      }

      // Also log any other block types briefly for context
      if (type !== 1337 && type !== 3 && type !== 52) {
        const label = type === 2 ? 'TEXT' : type === 46 ? 'BUTTON' : type === 18 ? 'MENU' : `TYPE-${type}`;
        const preview = type === 2
          ? (content.value?.html || '').replace(/<[^>]+>/g, '').substring(0, 60)
          : type === 46
            ? content.value?.label
            : '';
        console.log(`  Block ${bi}: ${label} (${blockId?.substring(0, 12)})${preview ? ` — "${preview}"` : ''}`);
      }
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Image blocks found: ${imageCount}`);
  console.log(`Gallery blocks found: ${galleryCount}`);

  if (imageCount === 0 && galleryCount === 0) {
    console.log('\nNo image/gallery blocks found on this page.');
    console.log('Try a different page with images, e.g.:');
    console.log(`  npx tsx scripts/discover-gallery-json.ts ${subdomain} coding-projects`);
  }
}

main().catch(e => console.error('Error:', e.message));
