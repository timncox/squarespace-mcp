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
const psiIdx = args.indexOf('--pageSectionsId');

if (siteIdx === -1 || pageIdx === -1) {
  console.error('Usage: npx tsx scripts/discover-block-types.ts --site <subdomain> --page <slug> [--pageSectionsId <id>]');
  process.exit(1);
}

const subdomain = args[siteIdx + 1];
const pageSlug = args[pageIdx + 1];
const pageSectionsIdOverride = psiIdx !== -1 ? args[psiIdx + 1] : undefined;

async function main() {
  console.log(`Discovering block types on ${subdomain} / ${pageSlug}...\n`);

  const client = new ContentSaveClient(subdomain);
  client.loadSessionCookies();

  let pageSectionsId: string;

  if (pageSectionsIdOverride) {
    pageSectionsId = pageSectionsIdOverride;
    console.log(`Using provided pageSectionsId: ${pageSectionsId}`);
  } else {
    // Resolve page IDs
    const pageIds = await client.getPageIds(pageSlug);
    if (!pageIds?.pageSectionsId) {
      console.error(`Could not resolve pageSectionsId for slug "${pageSlug}". Try passing --pageSectionsId directly (found in /api/page-sections/<id> calls in network tab or capture-api-traffic log).`);
      process.exit(1);
    }
    pageSectionsId = pageIds.pageSectionsId;
    console.log(`Page IDs: pageSectionsId=${pageSectionsId}, collectionId=${pageIds.collectionId}`);
  }

  // Get all sections
  const data = await client.getPageSections(pageSectionsId);
  const sections = data?.sections;
  if (!sections || sections.length === 0) {
    console.error('No sections found on page');
    process.exit(1);
  }

  console.log(`Found ${sections.length} sections\n`);

  // Known block type names (confirmed via live discovery, Feb 28 2026)
  const KNOWN_TYPES: Record<number, string> = {
    2: 'Text',
    8: 'Gallery',
    12: 'Page Link',
    14: 'Tag Cloud',
    18: 'Menu',
    22: 'Embed',
    23: 'Code (legacy 7.0?)',
    25: 'Instagram',
    31: 'Quote',
    32: 'Video (native)',
    33: 'Search Field',
    41: 'Audio',
    44: 'Markdown',
    46: 'Button (old type)',
    47: 'Line/Divider',
    49: 'RSS',
    51: 'Newsletter',
    52: 'Donation',
    54: 'Social Links',
    55: 'Summary',
    56: 'SoundCloud',
    61: 'Archive',
    62: 'Chart',
    65: 'Scheduling',
    66: 'OpenTable',
    68: 'Tock',
    69: 'Accordion',
    70: 'Scrolling/Marquee',
    1337: 'Image/Code/Map/Form/Shape (type 1337 variant)',
  };

  const discovery: Record<string, unknown[]> = {};

  for (let si = 0; si < sections.length; si++) {
    const section = sections[si];
    const gridContents = section?.fluidEngineContext?.gridContents;
    if (!gridContents) continue;

    for (let bi = 0; bi < gridContents.length; bi++) {
      const block = gridContents[bi];
      const blockType = block?.content?.value?.type;
      const typeName = KNOWN_TYPES[blockType] || `Unknown(${blockType})`;

      if (!discovery[typeName]) discovery[typeName] = [];

      discovery[typeName].push({
        sectionIndex: si,
        blockIndex: bi,
        blockId: block?.content?.value?.id,
        type: blockType,
        value: block?.content?.value?.value,
        // Include layout for reference
        desktop: block?.fluidEngineLayout?.desktop,
      });

      // Print summary
      const valuePreview = JSON.stringify(block?.content?.value?.value)?.substring(0, 120);
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
  const quoteBlocks = discovery['Quote'] ?? discovery['Quote (alt)'];
  const codeBlocks = discovery['Code'] ?? discovery['Image/Code-HTML'];

  if (quoteBlocks && quoteBlocks.length > 0) {
    const qt = (quoteBlocks[0] as any).type;
    console.log(`\n=== Quote Block (type ${qt}) ===`);
    console.log(JSON.stringify(quoteBlocks[0], null, 2));
  } else {
    console.log('\nWARNING: No quote blocks found. Check unknown types above.');
  }

  if (codeBlocks && codeBlocks.length > 0) {
    const ct = (codeBlocks[0] as any).type;
    console.log(`\n=== Code Block (type ${ct}) ===`);
    console.log(JSON.stringify(codeBlocks[0], null, 2));
  } else {
    console.log('\nWARNING: No code blocks found. Check unknown types above.');
  }
}

main().catch((err) => {
  console.error('Discovery failed:', err);
  process.exit(1);
});
