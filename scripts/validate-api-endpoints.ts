#!/usr/bin/env tsx
/**
 * Validate Speculative API Endpoints
 *
 * Tests the 3 untested API methods against a live Squarespace site:
 * 1. getSectionCatalog() — GET /api/section-catalog/sections?engine=FLUID
 * 2. addBlankSection(pageSectionsId) — POST /api/content/add/fluidEngineSection
 * 3. copyTemplateSection(websiteId, collectionId, sectionId) — POST /api/content/copy/section
 * 4. createPageViaApi(title, slug) — multiple endpoints
 * 5. Combined flow: createPage → addBlankSection → addTextBlock → verify
 *
 * Usage: npx tsx scripts/validate-api-endpoints.ts <subdomain> [page-slug]
 * Example: npx tsx scripts/validate-api-endpoints.ts grey-yellow-hbxc home
 */

import { createContentSaveClient, ContentSaveClient } from '../src/services/content-save.js';
import { resolvePageIds } from '../src/services/page-id-resolver.js';
import type { SectionCatalogEntry } from '../src/services/content-save.js';

// ── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log('Usage: npx tsx scripts/validate-api-endpoints.ts <subdomain> [page-slug]');
  console.log('Example: npx tsx scripts/validate-api-endpoints.ts grey-yellow-hbxc home');
  process.exit(0);
}

const subdomain = args[0];
const pageSlug = args[1] ?? 'home';

// ── Types ───────────────────────────────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
  error?: string;
  data?: Record<string, unknown>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function header(testNum: number, name: string): void {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Test ${testNum}: ${name}`);
  console.log('='.repeat(60));
}

function pass(msg: string): void {
  console.log(`  PASS -- ${msg}`);
}

function fail(msg: string): void {
  console.log(`  FAIL -- ${msg}`);
}

function info(msg: string): void {
  console.log(`  ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`Validate Speculative API Endpoints`);
  console.log(`Site: ${subdomain}.squarespace.com`);
  console.log(`Page: ${pageSlug}`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  const results: TestResult[] = [];

  // ── Pre-flight: Session health ──────────────────────────────────────────

  console.log('--- Pre-flight: Session Health ---');
  const health = ContentSaveClient.checkSessionHealth();
  console.log(`  Session exists: ${health.exists}`);
  console.log(`  Age (hours): ${health.ageHours >= 0 ? health.ageHours.toFixed(1) : 'N/A'}`);
  console.log(`  Stale (>24h): ${health.isStale}`);
  console.log(`  Has crumb: ${health.hasCrumb}`);

  if (!health.exists) {
    console.error('\nNo session file found. Run a browser session first to save login cookies.');
    process.exit(1);
  }

  if (!health.hasCrumb) {
    console.error('\nSession file has no crumb token. Re-authenticate via browser.');
    process.exit(1);
  }

  // Create the client
  let client: ContentSaveClient;
  try {
    client = createContentSaveClient(subdomain);
  } catch (err) {
    console.error(`\nFailed to create client: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // ── Pre-flight: Resolve page IDs ───────────────────────────────────────

  console.log('\n--- Pre-flight: Resolve Page IDs ---');
  let pageSectionsId: string;
  let collectionId: string;
  try {
    const ids = await resolvePageIds(subdomain, pageSlug);
    if (!ids) {
      console.error(`  Could not resolve page IDs for slug "${pageSlug}"`);
      process.exit(1);
    }
    pageSectionsId = ids.pageSectionsId;
    collectionId = ids.collectionId;
    console.log(`  pageSectionsId: ${pageSectionsId}`);
    console.log(`  collectionId:   ${collectionId}`);
  } catch (err) {
    console.error(`  Page ID resolution failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Store catalog data for use in Test 3
  let catalogContactEntry: SectionCatalogEntry | null = null;

  // ══════════════════════════════════════════════════════════════════════════
  //  Test 1: getSectionCatalog
  // ══════════════════════════════════════════════════════════════════════════

  header(1, 'getSectionCatalog');
  try {
    const catalogResult = await client.getSectionCatalog();

    if (!catalogResult.success) {
      fail(catalogResult.error ?? 'Unknown error');
      results.push({
        name: 'getSectionCatalog',
        passed: false,
        details: catalogResult.error ?? 'Unknown error',
        error: catalogResult.error,
      });
    } else {
      const categories = catalogResult.categories ?? [];
      const catalog = catalogResult.catalog ?? {};
      const totalEntries = catalogResult.sections?.length ?? 0;

      // Verify entries have required fields
      let validEntries = 0;
      let invalidEntries = 0;
      for (const entry of catalogResult.sections ?? []) {
        if (entry.websiteId && entry.collectionId && entry.sectionId) {
          validEntries++;
        } else {
          invalidEntries++;
        }
      }

      // Build category summary string
      const categorySummary = categories
        .map(cat => `${cat} (${(catalog[cat] ?? []).length})`)
        .join(', ');

      pass(`Found ${categories.length} categories with ${totalEntries} total entries`);
      info(`Categories: ${categorySummary}`);
      info(`Valid entries (have websiteId/collectionId/sectionId): ${validEntries}`);
      if (invalidEntries > 0) {
        info(`Invalid entries (missing required fields): ${invalidEntries}`);
      }

      // Store first CONTACT entry for Test 3
      const contactEntries = catalog['CONTACT'] ?? catalog['Contact'] ?? catalog['contact'] ?? [];
      if (contactEntries.length > 0) {
        catalogContactEntry = contactEntries[0];
        info(`Stored CONTACT entry for Test 3: sectionId=${catalogContactEntry.sectionId}`);
      } else {
        // Fall back to first entry from any category
        const firstCategory = categories[0];
        if (firstCategory && (catalog[firstCategory] ?? []).length > 0) {
          catalogContactEntry = catalog[firstCategory][0];
          info(`No CONTACT category found. Using first ${firstCategory} entry for Test 3: sectionId=${catalogContactEntry.sectionId}`);
        }
      }

      results.push({
        name: 'getSectionCatalog',
        passed: true,
        details: `${categories.length} categories, ${totalEntries} entries (${validEntries} valid)`,
        data: {
          categories: categories.length,
          totalEntries,
          validEntries,
          invalidEntries,
          categoryNames: categories,
        },
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(msg);
    results.push({
      name: 'getSectionCatalog',
      passed: false,
      details: msg,
      error: msg,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Test 2: addBlankSection
  // ══════════════════════════════════════════════════════════════════════════

  header(2, 'addBlankSection');
  try {
    // Count sections before
    const dataBefore = await client.getPageSections(pageSectionsId);
    const countBefore = dataBefore.sections?.length ?? 0;
    info(`Sections before: ${countBefore}`);

    // Add blank section
    const addResult = await client.addBlankSection(pageSectionsId);

    if (!addResult.success) {
      fail(addResult.error ?? 'Unknown error');
      results.push({
        name: 'addBlankSection',
        passed: false,
        details: addResult.error ?? 'Unknown error',
        error: addResult.error,
      });
    } else {
      info(`API returned sectionId: ${addResult.sectionId}`);

      // Check immediately
      const dataAfter = await client.getPageSections(pageSectionsId);
      const countAfter = dataAfter.sections?.length ?? 0;
      info(`Sections after (immediate): ${countAfter}`);

      // Wait 5 seconds and check persistence
      info(`Waiting 5 seconds to test persistence...`);
      await sleep(5000);
      const dataDelayed = await client.getPageSections(pageSectionsId);
      const countDelayed = dataDelayed.sections?.length ?? 0;
      info(`Sections after (5s delay): ${countDelayed}`);

      const increased = countAfter > countBefore;
      const persisted = countDelayed >= countAfter;

      if (increased && persisted) {
        pass(`Section count ${countBefore} -> ${countAfter}, persists after 5s`);
        info(`New section ID: ${addResult.sectionId}`);
      } else if (increased && !persisted) {
        fail(`Section count ${countBefore} -> ${countAfter} -> ${countDelayed} (LOST after 5s!)`);
        info(`Section was added but did not persist. May need browser editor save.`);
      } else {
        fail(`Section count did not increase: ${countBefore} -> ${countAfter}`);
        info(`API returned success but getPageSections shows no new section.`);
      }

      results.push({
        name: 'addBlankSection',
        passed: increased,
        details: increased
          ? `${countBefore} -> ${countAfter}, persists=${persisted}, sectionId=${addResult.sectionId}`
          : `Count did not increase: ${countBefore} -> ${countAfter}`,
        data: {
          countBefore,
          countAfter,
          countDelayed,
          increased,
          persisted,
          sectionId: addResult.sectionId,
        },
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(msg);
    results.push({
      name: 'addBlankSection',
      passed: false,
      details: msg,
      error: msg,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Test 3: copyTemplateSection
  // ══════════════════════════════════════════════════════════════════════════

  header(3, 'copyTemplateSection');
  if (!catalogContactEntry) {
    fail('No catalog entry available (Test 1 must pass first)');
    results.push({
      name: 'copyTemplateSection',
      passed: false,
      details: 'Skipped: no catalog entry from Test 1',
      error: 'No catalog entry available',
    });
  } else {
    try {
      info(`Source: websiteId=${catalogContactEntry.websiteId}`);
      info(`        collectionId=${catalogContactEntry.collectionId}`);
      info(`        sectionId=${catalogContactEntry.sectionId}`);

      const copyResult = await client.copyTemplateSection(
        catalogContactEntry.websiteId,
        catalogContactEntry.collectionId,
        catalogContactEntry.sectionId,
      );

      if (!copyResult.success) {
        fail(copyResult.error ?? 'Unknown error');
        results.push({
          name: 'copyTemplateSection',
          passed: false,
          details: copyResult.error ?? 'Unknown error',
          error: copyResult.error,
        });
      } else {
        pass(`Template section copied. New sectionId: ${copyResult.sectionId ?? '(not returned)'}`);
        if (copyResult.sectionData) {
          const dataKeys = Object.keys(copyResult.sectionData as Record<string, unknown>);
          info(`Response keys: ${dataKeys.join(', ')}`);
        }
        results.push({
          name: 'copyTemplateSection',
          passed: true,
          details: `sectionId=${copyResult.sectionId}`,
          data: {
            sectionId: copyResult.sectionId,
            responseKeys: copyResult.sectionData
              ? Object.keys(copyResult.sectionData as Record<string, unknown>)
              : [],
          },
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fail(msg);
      results.push({
        name: 'copyTemplateSection',
        passed: false,
        details: msg,
        error: msg,
      });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Test 4: createPageViaApi
  // ══════════════════════════════════════════════════════════════════════════

  header(4, 'createPageViaApi');
  const testSlug = `api-test-page-${Date.now()}`;
  let createdPageId: string | undefined;
  let createdPageUrlId: string | undefined;

  try {
    info(`Creating page: title="API Test Page", slug="${testSlug}"`);

    const createResult = await client.createPageViaApi('API Test Page', testSlug);

    if (!createResult.success) {
      if (!createResult.endpointAvailable) {
        fail('No page creation endpoint found (all returned 404/405)');
        info('This is expected -- page creation API may not be publicly available.');
      } else {
        fail(createResult.error ?? 'Unknown error');
      }
      results.push({
        name: 'createPageViaApi',
        passed: false,
        details: createResult.error ?? 'Unknown error',
        error: createResult.error,
        data: { endpointAvailable: createResult.endpointAvailable },
      });
    } else {
      createdPageId = createResult.pageId;
      createdPageUrlId = createResult.urlId;
      pass(`Page created. pageId=${createdPageId}, urlId=${createdPageUrlId}`);
      results.push({
        name: 'createPageViaApi',
        passed: true,
        details: `pageId=${createdPageId}, urlId=${createdPageUrlId}`,
        data: {
          pageId: createdPageId,
          urlId: createdPageUrlId,
          endpointAvailable: createResult.endpointAvailable,
        },
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(msg);
    results.push({
      name: 'createPageViaApi',
      passed: false,
      details: msg,
      error: msg,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Test 5: Combined flow — createPage → addBlankSection → addTextBlock → verify
  // ══════════════════════════════════════════════════════════════════════════

  header(5, 'Combined flow (createPage -> addBlankSection -> addTextBlock -> verify)');

  if (!createdPageId) {
    fail('Skipped: createPageViaApi did not succeed (Test 4 must pass first)');
    results.push({
      name: 'combinedFlow',
      passed: false,
      details: 'Skipped: Test 4 (createPageViaApi) did not succeed',
      error: 'Prerequisite test failed',
    });
  } else {
    try {
      // Resolve page IDs for the new page
      info(`Resolving IDs for new page slug: ${createdPageUrlId ?? testSlug}`);
      const newPageSlug = createdPageUrlId ?? testSlug;
      const newPageIds = await resolvePageIds(subdomain, newPageSlug);

      if (!newPageIds) {
        fail(`Could not resolve page IDs for new page "${newPageSlug}"`);
        info('The page may have been created but is not yet accessible via public HTML.');
        info('Attempting direct API lookup via getPageIds...');

        // Try direct API lookup
        const directIds = await client.getPageIds(newPageSlug);
        if (!directIds) {
          fail('Direct API lookup also failed. Combined flow cannot proceed.');
          results.push({
            name: 'combinedFlow',
            passed: false,
            details: `Could not resolve page IDs for "${newPageSlug}"`,
            error: 'Page ID resolution failed',
          });
        } else {
          info(`Direct API returned collectionId: ${directIds.collectionId}`);
          info(`Direct API returned pageSectionsId: ${directIds.pageSectionsId ?? 'N/A'}`);

          if (!directIds.pageSectionsId) {
            fail('No pageSectionsId returned. Combined flow cannot proceed.');
            results.push({
              name: 'combinedFlow',
              passed: false,
              details: 'No pageSectionsId for new page',
              error: 'Missing pageSectionsId',
            });
          } else {
            // Continue with the flow using direct IDs
            await runCombinedFlow(
              client,
              directIds.pageSectionsId,
              directIds.collectionId,
              results,
            );
          }
        }
      } else {
        info(`New page pageSectionsId: ${newPageIds.pageSectionsId}`);
        info(`New page collectionId:   ${newPageIds.collectionId}`);
        await runCombinedFlow(
          client,
          newPageIds.pageSectionsId,
          newPageIds.collectionId,
          results,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fail(msg);
      results.push({
        name: 'combinedFlow',
        passed: false,
        details: msg,
        error: msg,
      });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Summary
  // ══════════════════════════════════════════════════════════════════════════

  console.log(`\n${'='.repeat(60)}`);
  console.log('  SUMMARY');
  console.log('='.repeat(60));

  const maxNameLen = Math.max(...results.map(r => r.name.length));
  for (const r of results) {
    const status = r.passed ? 'PASS' : 'FAIL';
    const name = r.name.padEnd(maxNameLen);
    console.log(`  ${status}  ${name}  ${r.details}`);
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\n  Total: ${passed} passed, ${failed} failed out of ${results.length} tests`);

  // JSON output for programmatic consumption
  console.log('\n--- JSON Results ---');
  const jsonOutput = {
    subdomain,
    pageSlug,
    timestamp: new Date().toISOString(),
    sessionHealth: {
      ageHours: health.ageHours >= 0 ? Math.round(health.ageHours * 10) / 10 : null,
      isStale: health.isStale,
    },
    summary: { passed, failed, total: results.length },
    tests: results.map(r => ({
      name: r.name,
      passed: r.passed,
      details: r.details,
      ...(r.error ? { error: r.error } : {}),
      ...(r.data ? { data: r.data } : {}),
    })),
  };
  console.log(JSON.stringify(jsonOutput, null, 2));

  process.exit(failed > 0 ? 1 : 0);
}

// ── Combined flow helper ────────────────────────────────────────────────────

async function runCombinedFlow(
  client: ContentSaveClient,
  newPageSectionsId: string,
  newCollectionId: string,
  results: TestResult[],
): Promise<void> {
  // Step A: Check initial section count
  const initialData = await client.getPageSections(newPageSectionsId);
  const initialCount = initialData.sections?.length ?? 0;
  info(`Initial section count on new page: ${initialCount}`);

  // Step B: Add blank section
  info('Adding blank section to new page...');
  const blankResult = await client.addBlankSection(newPageSectionsId);
  if (!blankResult.success) {
    fail(`addBlankSection failed: ${blankResult.error}`);
    results.push({
      name: 'combinedFlow',
      passed: false,
      details: `addBlankSection failed: ${blankResult.error}`,
      error: blankResult.error,
    });
    return;
  }
  info(`Blank section added: sectionId=${blankResult.sectionId}`);

  // Step C: Verify section was added
  const afterBlankData = await client.getPageSections(newPageSectionsId);
  const afterBlankCount = afterBlankData.sections?.length ?? 0;
  info(`Section count after addBlankSection: ${afterBlankCount}`);

  if (afterBlankCount <= initialCount) {
    fail(`Section count did not increase: ${initialCount} -> ${afterBlankCount}`);
    results.push({
      name: 'combinedFlow',
      passed: false,
      details: `Section count did not increase after addBlankSection: ${initialCount} -> ${afterBlankCount}`,
    });
    return;
  }

  // Step D: Add text block to the new section (last section)
  const targetSectionIndex = afterBlankCount - 1;
  info(`Adding text block to section index ${targetSectionIndex}...`);

  const testHtml = `<p>API Validation Test - ${new Date().toISOString()}</p>`;
  const textResult = await client.addTextBlock(
    newPageSectionsId,
    newCollectionId,
    targetSectionIndex,
    testHtml,
  );

  if (!textResult.success) {
    fail(`addTextBlock failed: ${textResult.error}`);
    info('This is a known issue -- addTextBlock may return 500 on newly-created sections.');
    results.push({
      name: 'combinedFlow',
      passed: false,
      details: `addTextBlock failed: ${textResult.error}`,
      error: textResult.error,
      data: {
        addBlankSectionWorked: true,
        addTextBlockWorked: false,
        sectionCountIncreased: true,
      },
    });
    return;
  }

  info(`Text block added: blockId=${textResult.blockId}`);

  // Step E: Verify content via getPageSections
  info('Verifying content via getPageSections...');
  const finalData = await client.getPageSections(newPageSectionsId);
  const finalSection = finalData.sections?.[targetSectionIndex];
  const gridContents = finalSection?.fluidEngineContext?.gridContents ?? [];
  const hasTextBlock = gridContents.some(
    (gc: { content?: { type?: number; value?: { value?: string } } }) =>
      gc?.content?.type === 2 && gc?.content?.value?.value?.includes('API Validation Test'),
  );

  if (hasTextBlock) {
    pass('Full flow succeeded: createPage -> addBlankSection -> addTextBlock -> verified');
    info(`Section has ${gridContents.length} block(s), text content verified.`);
  } else {
    fail('Text block content not found in final verification');
    info(`Section has ${gridContents.length} block(s) but none contain the test text.`);
  }

  results.push({
    name: 'combinedFlow',
    passed: hasTextBlock,
    details: hasTextBlock
      ? `Full flow OK: ${afterBlankCount} sections, text block verified`
      : `Text content not found in section ${targetSectionIndex}`,
    data: {
      addBlankSectionWorked: true,
      addTextBlockWorked: textResult.success,
      contentVerified: hasTextBlock,
      blockCount: gridContents.length,
      sectionCountBefore: initialCount,
      sectionCountAfter: afterBlankCount,
    },
  });
}

// ── Run ─────────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
