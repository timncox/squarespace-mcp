#!/usr/bin/env npx tsx
/**
 * Live test of ContentSaveClient against grey-yellow-hbxc.
 *
 * Usage:
 *   npx tsx scripts/test-content-save.ts                    # read-only: list text blocks
 *   npx tsx scripts/test-content-save.ts --edit             # make a test edit (and revert)
 */

import { createContentSaveClient } from '../src/services/content-save.js';

const SUBDOMAIN = 'grey-yellow-hbxc';
// Known IDs from capture data and API exploration (Feb 21, 2026)
const PAGE_SECTIONS_ID = '6993497ab23b0453e46b65aa';
const COLLECTION_ID = '6993497ab23b0453e46b65ab';

const args = process.argv.slice(2);
const doEdit = args.includes('--edit');

async function main() {
  console.log(`\n--- ContentSaveClient live test — ${SUBDOMAIN} ---\n`);

  // Step 1: Create client
  console.log('1. Loading session cookies...');
  const client = createContentSaveClient(SUBDOMAIN);
  console.log('   OK\n');

  // Step 2: Test getPageIds (authenticated GetCollections)
  console.log('2. Getting collection ID via GetCollections API...');
  const ids = await client.getPageIds('home');
  console.log(`   collectionId: ${ids?.collectionId ?? 'NOT FOUND'}`);
  console.log(`   Expected: ${COLLECTION_ID}`);
  console.log(`   Match: ${ids?.collectionId === COLLECTION_ID ? 'YES' : 'NO'}\n`);

  // Step 3: GET current page sections (uses /api/page-sections/{id} without /collection/)
  console.log('3. Fetching page sections via GET /api/page-sections/...');
  const startGet = Date.now();
  const data = await client.getPageSections(PAGE_SECTIONS_ID);
  const getMs = Date.now() - startGet;
  console.log(`   Fetched in ${getMs}ms`);
  console.log(`   Sections: ${data.sections.length}`);
  console.log(`   pageSectionsId: ${data.id}`);
  console.log(`   collectionId: ${data.collectionId}\n`);

  // Step 4: List all text blocks
  console.log('4. Text blocks on home page:\n');
  let blockCount = 0;
  for (let si = 0; si < data.sections.length; si++) {
    const section = data.sections[si];
    const gridContents = section.fluidEngineContext?.gridContents;
    if (!gridContents) continue;

    for (const gc of gridContents) {
      const blockValue = gc.content?.value;
      if (!blockValue || blockValue.type !== 2) continue;
      blockCount++;
      const html = blockValue.value?.html ?? '';
      const plainText = html
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
      const preview = plainText.length > 80 ? plainText.slice(0, 80) + '...' : plainText;
      console.log(`   [Section ${si}] id: ${blockValue.id}`);
      console.log(`   Text: "${preview}"`);
      console.log(`   HTML: ${html.slice(0, 100)}${html.length > 100 ? '...' : ''}\n`);
    }
  }
  console.log(`   Total text blocks: ${blockCount}\n`);

  // Step 5: Test edit (round-trip: edit then revert)
  if (doEdit && blockCount > 0) {
    // Find the first text block
    let targetBlockId: string | null = null;
    let originalHtml: string | null = null;
    for (const section of data.sections) {
      const gridContents = section.fluidEngineContext?.gridContents;
      if (!gridContents) continue;
      for (const gc of gridContents) {
        const bv = gc.content?.value;
        if (bv?.type === 2 && bv.value?.html) {
          targetBlockId = bv.id;
          originalHtml = bv.value.html;
          break;
        }
      }
      if (targetBlockId) break;
    }

    if (!targetBlockId || !originalHtml) {
      console.log('5. No editable text block found.\n');
      return;
    }

    const originalText = originalHtml
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    console.log(`5. Testing edit on block: ${targetBlockId}`);
    console.log(`   Current text: "${originalText}"`);

    // Edit: change text to test value
    const testText = 'API_SAVE_TEST';
    console.log(`   Saving: "${testText}"...`);
    const startEdit = Date.now();
    const editResult = await client.updateTextBlock(
      PAGE_SECTIONS_ID, COLLECTION_ID, originalText.slice(0, 30), testText,
    );
    const editMs = Date.now() - startEdit;
    console.log(`   Result: ${editResult.success ? 'SUCCESS' : 'FAILED'} (${editMs}ms)`);
    if (editResult.error) console.log(`   Error: ${editResult.error}`);

    if (editResult.success) {
      // Verify
      console.log('\n   Verifying...');
      const verifyData = await client.getPageSections(PAGE_SECTIONS_ID);
      let verified = false;
      for (const section of verifyData.sections) {
        const gcs = section.fluidEngineContext?.gridContents;
        if (!gcs) continue;
        for (const gc of gcs) {
          const bv = gc.content?.value;
          if (bv?.id === targetBlockId && bv.value?.html?.includes(testText)) {
            verified = true;
          }
        }
      }
      console.log(`   Verified: ${verified ? 'YES - edit persisted!' : 'NO - edit not found'}`);

      // Revert
      console.log('\n   Reverting to original...');
      const startRevert = Date.now();
      const revertResult = await client.updateTextBlock(
        PAGE_SECTIONS_ID, COLLECTION_ID, testText, originalHtml,
      );
      const revertMs = Date.now() - startRevert;
      console.log(`   Revert: ${revertResult.success ? 'SUCCESS' : 'FAILED'} (${revertMs}ms)`);
      if (revertResult.error) console.log(`   Error: ${revertResult.error}`);
    }
  } else if (doEdit) {
    console.log('5. No text blocks to edit.\n');
  }

  console.log('\nDone.\n');
}

main().catch((err) => {
  console.error('\nError:', err.message ?? err);
  process.exit(1);
});
