/**
 * Delete the two zero-height blocks on the grey-yellow-hbxc home page.
 *
 * Identified by check-overlaps.ts:
 *   - Section 0, Block 4 (type 47): X 11-14, Y 14-14
 *   - Section 4, Block 0 (type 2):  X 3-22,  Y 0-0
 *
 * Uses read-modify-write: GET → splice → PUT.
 */
import { createContentSaveClient } from '../src/services/content-save.js';

const SITE_ID = 'grey-yellow-hbxc';
const PAGE_SECTIONS_ID = '6993497ab23b0453e46b65aa';
const COLLECTION_ID = '6993497ab23b0453e46b65ab';

function isZeroHeight(gc: any): boolean {
  const d = gc?.layout?.desktop;
  return d != null && d.start?.y === d.end?.y;
}

async function main() {
  const client = createContentSaveClient(SITE_ID);
  const data = await client.getPageSections(PAGE_SECTIONS_ID);
  const sections = data.sections;

  let removed = 0;

  for (let si = 0; si < sections.length; si++) {
    const gc = sections[si].fluidEngineContext?.gridContents;
    if (!gc) continue;

    const before = gc.length;
    const zeroBlocks = gc.filter(isZeroHeight);
    if (zeroBlocks.length === 0) continue;

    for (const b of zeroBlocks) {
      const d = b.layout?.desktop;
      const type = b.content?.value?.type ?? '?';
      console.log(`Section ${si}: removing type ${type} block at X ${d?.start?.x}-${d?.end?.x}, Y ${d?.start?.y}-${d?.end?.y}`);
    }

    // Splice out all zero-height blocks in this section
    sections[si].fluidEngineContext!.gridContents = gc.filter((b: any) => !isZeroHeight(b));
    removed += before - sections[si].fluidEngineContext!.gridContents.length;
  }

  if (removed === 0) {
    console.log('No zero-height blocks found — nothing to do.');
    return;
  }

  console.log(`\nRemoving ${removed} block(s)... saving...`);
  const result = await client.savePageSections(PAGE_SECTIONS_ID, COLLECTION_ID, sections);

  if (result.success) {
    console.log(`✓ Saved. ${removed} zero-height block(s) deleted.`);
  } else {
    console.error('✗ Save failed:', result.error);
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
