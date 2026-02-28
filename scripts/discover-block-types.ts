#!/usr/bin/env tsx
/**
 * Phase 0A Discovery: Discover quote & code block type numbers and value structures.
 *
 * Usage:
 *   npx tsx scripts/discover-block-types.ts --site <subdomain> --page <slug>
 *
 * The target page should contain at least one Quote block and one Code block.
 * Outputs full gridContent JSON for each block to data/block-type-discovery.json.
 */

import { ContentSaveClient } from '../src/services/content-save.js';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

const args = process.argv.slice(2);
const siteIdx = args.indexOf('--site');
const pageIdx = args.indexOf('--page');

if (siteIdx === -1 || pageIdx === -1) {
  console.error('Usage: npx tsx scripts/discover-block-types.ts --site <subdomain> --page <slug>');
  process.exit(1);
}

const subdomain = args[siteIdx + 1];
const pageSlug = args[pageIdx + 1];

async function main() {
  console.log(`Discovering block types on ${subdomain} / ${pageSlug}...\n`);

  const client = new ContentSaveClient(subdomain);
  await client.loadCookies();

  // Resolve page IDs
  const pageIds = await client.getPageIds(pageSlug);
  if (!pageIds) {
    console.error(`Could not resolve page IDs for slug "${pageSlug}"`);
    process.exit(1);
  }
  console.log(`Page IDs: pageSectionsId=${pageIds.pageSectionsId}, collectionId=${pageIds.collectionId}`);

  // Get all sections
  const sections = await client.getPageSections(pageIds.pageSectionsId);
  if (!sections || sections.length === 0) {
    console.error('No sections found on page');
    process.exit(1);
  }

  console.log(`Found ${sections.length} sections\n`);

  // Known block type names (from coordinator.ts and content-save.ts)
  const KNOWN_TYPES: Record<number, string> = {
    2: 'Text',
    18: 'Menu',
    23: 'Code (suspected)',
    44: 'Quote (suspected)',
    46: 'Button',
    1337: 'Image',
    8: 'Gallery',
  };

  const discovery: Record<string, unknown[]> = {};

  for (let si = 0; si < sections.length; si++) {
    const section = sections[si];
    const gridContents = section?.fluidEngineContext?.gridContents;
    if (!gridContents) continue;

    for (let bi = 0; bi < gridContents.length; bi++) {
      const block = gridContents[bi];
      const blockType = block?.content?.type;
      const typeName = KNOWN_TYPES[blockType] || `Unknown(${blockType})`;

      if (!discovery[typeName]) discovery[typeName] = [];

      discovery[typeName].push({
        sectionIndex: si,
        blockIndex: bi,
        blockId: block?.content?.id,
        type: blockType,
        value: block?.content?.value,
        // Include layout for reference
        desktop: block?.fluidEngineLayout?.desktop,
      });

      // Print summary
      const valuePreview = JSON.stringify(block?.content?.value)?.substring(0, 120);
      console.log(`Section ${si}, Block ${bi}: type=${blockType} (${typeName})`);
      console.log(`  ID: ${block?.content?.id}`);
      console.log(`  Value preview: ${valuePreview}...`);
      console.log();
    }
  }

  // Write full discovery
  const outPath = resolve('data', 'block-type-discovery.json');
  writeFileSync(outPath, JSON.stringify(discovery, null, 2));
  console.log(`\nFull discovery written to ${outPath}`);

  // Summary
  console.log('\n=== Block Type Summary ===');
  for (const [typeName, blocks] of Object.entries(discovery)) {
    console.log(`  ${typeName}: ${blocks.length} block(s)`);
  }

  // Check for quote/code specifically
  const quoteBlocks = discovery['Quote (suspected)'];
  const codeBlocks = discovery['Code (suspected)'];

  if (quoteBlocks && quoteBlocks.length > 0) {
    console.log('\n=== CONFIRMED: Quote Block (type 44) ===');
    console.log(JSON.stringify(quoteBlocks[0], null, 2));
  } else {
    console.log('\nWARNING: No type 44 blocks found. Check all unknown types above.');
  }

  if (codeBlocks && codeBlocks.length > 0) {
    console.log('\n=== CONFIRMED: Code Block (type 23) ===');
    console.log(JSON.stringify(codeBlocks[0], null, 2));
  } else {
    console.log('\nWARNING: No type 23 blocks found. Check all unknown types above.');
  }
}

main().catch((err) => {
  console.error('Discovery failed:', err);
  process.exit(1);
});
