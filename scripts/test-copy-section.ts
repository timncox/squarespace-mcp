/**
 * Debug copyTemplateSection — try with known-good IDs from captured traffic.
 * Usage: npx tsx scripts/test-copy-section.ts
 */
import { createContentSaveClient } from '../src/services/content-save.js';

async function main() {
  const client = createContentSaveClient('grey-yellow-hbxc');

  // These are the exact IDs from captured traffic that returned 200
  const knownGood = {
    sourceWebsiteId: '5ec321c2af33de48734cc929',
    sourceCollectionId: '6871312cd0c1907e34e4c93c',
    sourceSectionId: '68752af3e14e583c42ca6caa',
  };

  console.log('=== Test 1: Known-good IDs from captured traffic ===');
  const result1 = await client.copyTemplateSection(
    knownGood.sourceWebsiteId,
    knownGood.sourceCollectionId,
    knownGood.sourceSectionId,
  );
  console.log('Result:', JSON.stringify(result1).substring(0, 500));

  // Try the CONTACT template that failed before
  console.log('\n=== Test 2: CONTACT template from catalog ===');
  const catalog = await client.getSectionCatalog();
  if (catalog.success && catalog.catalog) {
    const contact = catalog.catalog['CONTACT']?.[0];
    if (contact) {
      console.log('Entry:', JSON.stringify(contact).substring(0, 300));
      const result2 = await client.copyTemplateSection(
        contact.websiteId,
        contact.collectionId,
        contact.sectionId,
      );
      console.log('Result:', JSON.stringify(result2).substring(0, 500));
    }
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
