/**
 * Snapshot page sections + header/footer config.
 * Usage: npx tsx scripts/snapshot-header.ts [site-id] [pageSectionsId] [output-prefix]
 */
import { createContentSaveClient } from '../src/services/content-save.js';
import { writeFileSync, mkdirSync } from 'fs';

async function main() {
  const siteId = process.argv[2] || 'grey-yellow-hbxc';
  const psId = process.argv[3] || '6993497ab23b0453e46b65aa';
  const prefix = process.argv[4] || 'storage/recordings/snapshot';

  mkdirSync('storage/recordings', { recursive: true });

  const client = createContentSaveClient(siteId);

  const sections = await client.getPageSections(psId);
  writeFileSync(`${prefix}-pages.json`, JSON.stringify(sections, null, 2));
  console.log(`Page sections: ${sections.sections.length} sections saved`);

  const hf = await client.getHeaderFooter();
  writeFileSync(`${prefix}-headerfooter.json`, JSON.stringify(hf, null, 2));
  console.log(`Header/footer config saved (${JSON.stringify(hf).length} bytes)`);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
