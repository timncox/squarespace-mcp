/**
 * Quick snapshot of a page's sections via Content Save API.
 * Usage: npx tsx scripts/snapshot-page.ts [site-id] [pageSectionsId] [output-file]
 */
import { createContentSaveClient } from '../src/services/content-save.js';
import { writeFileSync, mkdirSync } from 'fs';

async function main() {
  const siteId = process.argv[2] || 'grey-yellow-hbxc';
  const psId = process.argv[3] || '6993497ab23b0453e46b65aa';
  const outFile = process.argv[4] || 'storage/recordings/snapshot.json';

  mkdirSync('storage/recordings', { recursive: true });

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
