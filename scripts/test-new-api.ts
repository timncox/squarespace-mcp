/**
 * Live test of new API methods against Smyth Tavern.
 * Usage: npx tsx scripts/test-new-api.ts
 *        npx tsx scripts/test-new-api.ts --write   (enables mutations)
 */
import { createContentSaveClient } from '../src/services/content-save.js';

const SITE = 'grey-yellow-hbxc';
const PS_ID = '6993497ab23b0453e46b65aa';
const COLL_ID = '6993497ab23b0453e46b65ab';

async function main() {
  const client = createContentSaveClient(SITE);

  console.log('=== 1. getSectionCatalog() ===');
  const catalog = await client.getSectionCatalog();
  console.log('Success:', catalog.success);
  if (catalog.success && catalog.categories) {
    console.log('Categories:', catalog.categories.length);
    for (const cat of catalog.categories.slice(0, 8)) {
      const entries = catalog.catalog![cat];
      console.log(`  ${cat}: ${entries.length} templates`);
    }
    if (catalog.categories.length > 8) {
      console.log(`  ... and ${catalog.categories.length - 8} more categories`);
    }
    console.log('Total templates:', catalog.sections!.length);
  } else {
    console.log('Error:', catalog.error);
  }

  console.log('\n=== 2. getGalleryItems() ===');
  // First find the gallery block to get its collectionId
  const data = await client.getPageSections(PS_ID);
  const galleryMatch = client.findGalleryBlock(data.sections);
  if (galleryMatch) {
    console.log('Found gallery block:', galleryMatch.galleryCollectionId);
    const items = await client.getGalleryItems(galleryMatch.galleryCollectionId);
    console.log('Success:', items.success);
    if (items.success && items.items) {
      console.log('Items:', items.items.length);
      console.log('Has more:', items.hasMore);
      for (let i = 0; i < Math.min(3, items.items.length); i++) {
        const item = items.items[i];
        console.log(`  [${i}] id=${item.id}, filename=${item.filename ?? '?'}, title=${item.title ?? '(none)'}`);
      }
    } else {
      console.log('Error:', items.error);
    }

    console.log('\n=== 3. getGalleryItemCount() ===');
    const count = await client.getGalleryItemCount(galleryMatch.galleryCollectionId);
    console.log('Success:', count.success);
    console.log('Count:', count.count);
    if (!count.success) console.log('Error:', count.error);
  } else {
    console.log('No gallery block found on page — skipping gallery tests');
  }

  console.log('\n=== 4. updateGallerySettings() (dry run — read only) ===');
  if (galleryMatch) {
    const val = galleryMatch.gridContent.content.value.value ?? {};
    console.log('Current settings:');
    console.log('  thumbnails-per-row:', val['thumbnails-per-row']);
    console.log('  aspect-ratio:', val['aspect-ratio']);
    console.log('  design:', val.design);
    console.log('  padding:', val.padding);
    console.log('  lightbox:', val.lightbox);
    console.log('(Not modifying — pass --write to actually update)');

    if (process.argv.includes('--write')) {
      console.log('\n  Actually updating thumbnails-per-row to 3...');
      const result = await client.updateGallerySettings(
        PS_ID, COLL_ID, galleryMatch.galleryCollectionId,
        { 'thumbnails-per-row': 3 },
      );
      console.log('  Result:', result);
    }
  }

  console.log('\n=== 5. addBlankSection() ===');
  if (process.argv.includes('--write')) {
    const result = await client.addBlankSection(PS_ID);
    console.log('Result:', result);
  } else {
    console.log('(Not modifying — pass --write to actually add a section)');
  }

  console.log('\n=== 6. copyTemplateSection() ===');
  if (catalog.success && catalog.sections && catalog.sections.length > 0) {
    // Pick a CONTACT template as a safe example
    const contactEntries = catalog.catalog?.['CONTACT'] ?? [];
    const entry = contactEntries[0] ?? catalog.sections[0];
    console.log('Selected template:');
    console.log('  websiteId:', entry.websiteId);
    console.log('  collectionId:', entry.collectionId);
    console.log('  sectionId:', entry.sectionId);
    console.log('  tags:', entry.taxonomy?.tags?.join(', ') ?? '(none)');

    if (process.argv.includes('--write')) {
      console.log('\n  Copying template section...');
      const result = await client.copyTemplateSection(
        entry.websiteId,
        entry.collectionId,
        entry.sectionId,
      );
      console.log('  Result:', JSON.stringify(result).substring(0, 300));
    } else {
      console.log('(Not modifying — pass --write to copy a section)');
    }
  }

  console.log('\n✅ Done!');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
