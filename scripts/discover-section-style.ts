#!/usr/bin/env tsx
/**
 * Section Style Discovery: Capture section-level JSON (excluding gridContents)
 * for before/after diffing when making style changes in the Squarespace editor.
 *
 * Usage:
 *   npx tsx scripts/discover-section-style.ts --site <subdomain> --page <slug> [--label <label>]
 *
 * Outputs to data/section-style-<label>.json
 * Default label: "baseline"
 *
 * Example:
 *   npx tsx scripts/discover-section-style.ts --site grey-yellow-hbxc --page test-page --label baseline
 *   npx tsx scripts/discover-section-style.ts --site grey-yellow-hbxc --page test-page --label after-color
 */

import { ContentSaveClient } from '../src/services/content-save.js';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const args = process.argv.slice(2);
const siteIdx = args.indexOf('--site');
const pageIdx = args.indexOf('--page');
const labelIdx = args.indexOf('--label');
const psiIdx = args.indexOf('--pageSectionsId');

if (siteIdx === -1 || pageIdx === -1) {
  console.error('Usage: npx tsx scripts/discover-section-style.ts --site <subdomain> --page <slug> [--label <label>] [--pageSectionsId <id>]');
  process.exit(1);
}

const subdomain = args[siteIdx + 1];
const pageSlug = args[pageIdx + 1];
const label = labelIdx !== -1 ? args[labelIdx + 1] : 'baseline';
const pageSectionsIdOverride = psiIdx !== -1 ? args[psiIdx + 1] : undefined;

async function main() {
  console.log(`Capturing section styles on ${subdomain} / ${pageSlug} (label: ${label})...\n`);

  const client = new ContentSaveClient(subdomain);
  client.loadSessionCookies();

  let pageSectionsId: string;

  if (pageSectionsIdOverride) {
    pageSectionsId = pageSectionsIdOverride;
    console.log(`Using provided pageSectionsId: ${pageSectionsId}`);
  } else {
    const pageIds = await client.getPageIds(pageSlug);
    if (!pageIds?.pageSectionsId) {
      console.error(`Could not resolve pageSectionsId for slug "${pageSlug}". Try passing --pageSectionsId directly.`);
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

  // Capture section-level fields WITHOUT gridContents (too noisy for diffs)
  const sectionSnapshots = sections.map((section, idx) => {
    const { fluidEngineContext, ...rest } = section as Record<string, unknown>;
    const fcWithoutGrid = fluidEngineContext
      ? Object.fromEntries(
          Object.entries(fluidEngineContext as Record<string, unknown>).filter(
            ([k]) => k !== 'gridContents',
          ),
        )
      : undefined;

    return {
      index: idx,
      id: section.id,
      sectionName: section.sectionName,
      // Section-level style fields (the ones we care about)
      sectionTheme: (section as Record<string, unknown>).sectionTheme,
      backgroundColor: (section as Record<string, unknown>).backgroundColor,
      sectionHeight: (section as Record<string, unknown>).sectionHeight,
      paddingTop: (section as Record<string, unknown>).paddingTop,
      paddingBottom: (section as Record<string, unknown>).paddingBottom,
      blockSpacing: (section as Record<string, unknown>).blockSpacing,
      contentWidth: (section as Record<string, unknown>).contentWidth,
      verticalAlignment: (section as Record<string, unknown>).verticalAlignment,
      // Catch-all for any OTHER section-level fields (where new ones may appear)
      _allSectionFields: rest,
      // Fluid engine context fields (except gridContents)
      _fluidEngineContextFields: fcWithoutGrid,
    };
  });

  // Write to data/section-style-<label>.json
  const outPath = resolve('data', `section-style-${label}.json`);
  writeFileSync(outPath, JSON.stringify(sectionSnapshots, null, 2));
  console.log(`Written to ${outPath}`);

  // Print section summaries
  console.log('\n=== Section Summary ===');
  for (const snap of sectionSnapshots) {
    console.log(`\nSection ${snap.index}: "${snap.sectionName}" (${snap.id})`);
    console.log(`  sectionTheme:     ${JSON.stringify(snap.sectionTheme)}`);
    console.log(`  backgroundColor:  ${JSON.stringify(snap.backgroundColor)}`);
    console.log(`  sectionHeight:    ${JSON.stringify(snap.sectionHeight)}`);
    console.log(`  paddingTop:       ${JSON.stringify(snap.paddingTop)}`);
    console.log(`  paddingBottom:    ${JSON.stringify(snap.paddingBottom)}`);
    console.log(`  blockSpacing:     ${JSON.stringify(snap.blockSpacing)}`);
    console.log(`  contentWidth:     ${JSON.stringify(snap.contentWidth)}`);
    console.log(`  verticalAlignment:${JSON.stringify(snap.verticalAlignment)}`);
    const knownKeys = new Set([
      'id', 'sectionName', 'fluidEngineContext',
      'sectionTheme', 'backgroundColor', 'sectionHeight',
      'paddingTop', 'paddingBottom', 'blockSpacing',
      'contentWidth', 'verticalAlignment',
    ]);
    const unknownFields = Object.entries(snap._allSectionFields)
      .filter(([k]) => !knownKeys.has(k));
    if (unknownFields.length > 0) {
      console.log(`  --- Other fields ---`);
      for (const [k, v] of unknownFields) {
        console.log(`  ${k}: ${JSON.stringify(v)}`);
      }
    }
  }

  // If a previous label exists, diff automatically
  const previousLabels: Record<string, string> = {
    'after-color': 'baseline',
    'after-divider': 'after-color',
    'after-divider2': 'after-color',
  };
  const prevLabel = previousLabels[label];
  if (prevLabel) {
    const prevPath = resolve('data', `section-style-${prevLabel}.json`);
    if (existsSync(prevPath)) {
      console.log(`\n=== Diff vs ${prevLabel} ===`);
      const prevData = JSON.parse(readFileSync(prevPath, 'utf8')) as typeof sectionSnapshots;
      for (let i = 0; i < Math.max(sectionSnapshots.length, prevData.length); i++) {
        const curr = sectionSnapshots[i];
        const prev = prevData[i];
        if (!curr || !prev) continue;
        const fields = new Set([
          ...Object.keys(curr._allSectionFields),
          ...Object.keys(prev._allSectionFields),
        ]);
        const changes: string[] = [];
        for (const f of fields) {
          const cv = JSON.stringify(curr._allSectionFields[f as keyof typeof curr._allSectionFields]);
          const pv = JSON.stringify(prev._allSectionFields[f as keyof typeof prev._allSectionFields]);
          if (cv !== pv) {
            changes.push(`  ${f}: ${pv} → ${cv}`);
          }
        }
        // Also diff fluidEngineContext fields
        const fcFields = new Set([
          ...Object.keys(curr._fluidEngineContextFields ?? {}),
          ...Object.keys(prev._fluidEngineContextFields ?? {}),
        ]);
        for (const f of fcFields) {
          const cv = JSON.stringify((curr._fluidEngineContextFields as Record<string, unknown>)?.[f]);
          const pv = JSON.stringify((prev._fluidEngineContextFields as Record<string, unknown>)?.[f]);
          if (cv !== pv) {
            changes.push(`  fluidEngineContext.${f}: ${pv} → ${cv}`);
          }
        }
        if (changes.length > 0) {
          console.log(`\nSection ${i} "${curr.sectionName}" changed:`);
          for (const c of changes) console.log(c);
        }
      }
    }
  }
}

main().catch((err) => {
  console.error('Discovery failed:', err);
  process.exit(1);
});
