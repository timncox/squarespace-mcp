/**
 * Quick test of addTextBlock API to verify verticalAlignment/zIndex fix.
 * Run: npx tsx scripts/test-add-block.ts
 */
import { createContentSaveClient } from '../src/services/content-save.js';

async function test() {
  const client = createContentSaveClient('tim-cox');
  await client.loadSessionCookies();

  // Find the home page (always exists)
  const ids = await client.getPageIds('home');
  if (!ids) { console.log('No home page found'); return; }
  console.log('Page IDs:', JSON.stringify(ids));

  // Get sections
  const data = await client.getPageSections(ids.pageSectionsId);
  console.log('Sections:', data.sections.length);

  // Try adding a text block to the last section
  const lastSectionIdx = data.sections.length - 1;
  console.log(`Adding text block to section ${lastSectionIdx}...`);

  const result = await client.addTextBlock(
    ids.pageSectionsId,
    ids.collectionId,
    lastSectionIdx,
    '<h3>API Test Block</h3><p>This block was added via the Content Save API addTextBlock method with verticalAlignment and zIndex fields.</p>',
  );

  console.log('Result:', JSON.stringify(result, null, 2));
}

test().catch(console.error);
