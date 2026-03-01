/**
 * Check for overlapping or malformed blocks on a page via the Content Save API.
 *
 * Overlapping blocks are unusual — Squarespace Fluid Engine supports intentional
 * layering, but it must be deliberately specified. Use --allow-overlaps-in-section <N>
 * to suppress overlap warnings for a specific section (e.g., a hand-crafted hero).
 *
 * Also flags zero-height blocks (start.y === end.y), which are never valid.
 *
 * Usage:
 *   npx tsx scripts/check-overlaps.ts --site grey-yellow-hbxc --page home
 *   npx tsx scripts/check-overlaps.ts --site grey-yellow-hbxc --page home --allow-overlaps-in-section 0
 */
import { createContentSaveClient } from '../src/services/content-save.js';

function hexAdd(id: string, delta: number): string {
  const n = BigInt('0x' + id) + BigInt(delta);
  return n.toString(16).padStart(id.length, '0');
}

async function resolvePageSectionsId(
  client: ReturnType<typeof createContentSaveClient>,
  pageSlug: string,
): Promise<string | null> {
  const ids = await client.getPageIds(pageSlug);
  if (!ids) {
    console.error(`Could not resolve collectionId for slug "${pageSlug}"`);
    return null;
  }
  console.log(`collectionId: ${ids.collectionId}`);

  for (const delta of [-3, -2, -1, 0, 1, 2, 3]) {
    const candidate = hexAdd(ids.collectionId, delta);
    try {
      const result = await client.getPageSections(candidate);
      if (result?.sections) {
        console.log(`pageSectionsId: ${candidate} (delta ${delta >= 0 ? '+' : ''}${delta}), ${result.sections.length} sections`);
        return candidate;
      }
    } catch { /* skip */ }
  }

  console.error('Could not find pageSectionsId via hex probing');
  return null;
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

async function main() {
  const args = process.argv.slice(2);
  const getFlag = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : undefined; };
  const getAllFlags = (f: string): number[] => {
    const results: number[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === f && args[i + 1] != null) results.push(Number(args[i + 1]));
    }
    return results;
  };

  const siteId = getFlag('--site') ?? 'grey-yellow-hbxc';
  const pageSlug = getFlag('--page') ?? 'home';
  const allowOverlapSections = new Set(getAllFlags('--allow-overlaps-in-section'));

  const client = createContentSaveClient(siteId);
  const psId = await resolvePageSectionsId(client, pageSlug);
  if (!psId) { process.exit(1); }
  console.log();

  const data = await client.getPageSections(psId);
  const sections = data.sections;

  console.log(`Found ${sections.length} sections\n`);

  let totalIssues = 0;

  for (let si = 0; si < sections.length; si++) {
    const section = sections[si];
    const blocks = section.fluidEngineContext?.gridContents ?? [];

    if (blocks.length === 0) {
      console.log(`Section ${si} (${section.id?.slice(0, 8)}): no blocks`);
      continue;
    }

    const overlapsAllowed = allowOverlapSections.has(si);
    console.log(`Section ${si} (${section.id?.slice(0, 8)}): ${blocks.length} block(s)${overlapsAllowed ? ' [overlaps allowed]' : ''}`);

    const issues: string[] = [];

    for (let bi = 0; bi < blocks.length; bi++) {
      const d = blocks[bi].layout?.desktop;
      if (!d) { console.log(`  Block ${bi}: no desktop layout`); continue; }

      const type = (blocks[bi].content?.value as any)?.type ?? '?';
      const zeroHeight = d.start?.y === d.end?.y;
      const zeroFlag = zeroHeight ? ' ⚠ ZERO-HEIGHT' : '';
      console.log(`  Block ${bi} (type ${type}): X ${d.start?.x}-${d.end?.x}, Y ${d.start?.y}-${d.end?.y}${zeroFlag}`);

      if (zeroHeight) {
        issues.push(`  ⚠ ZERO-HEIGHT: Block ${bi} (type ${type}) has start.y === end.y === ${d.start?.y} — block has no height and will be invisible`);
      }
    }

    if (!overlapsAllowed) {
      for (let i = 0; i < blocks.length; i++) {
        for (let j = i + 1; j < blocks.length; j++) {
          const di = blocks[i].layout?.desktop;
          const dj = blocks[j].layout?.desktop;
          if (!di || !dj) continue;

          const xOverlap = rangesOverlap(di.start.x, di.end.x, dj.start.x, dj.end.x);
          const yOverlap = rangesOverlap(di.start.y, di.end.y, dj.start.y, dj.end.y);

          if (xOverlap && yOverlap) {
            issues.push(
              `  ⚠ OVERLAP: Block ${i} (X ${di.start.x}-${di.end.x}, Y ${di.start.y}-${di.end.y}) ` +
              `overlaps Block ${j} (X ${dj.start.x}-${dj.end.x}, Y ${dj.start.y}-${dj.end.y}) ` +
              `— use --allow-overlaps-in-section ${si} if intentional`,
            );
          }
        }
      }
    }

    if (issues.length > 0) {
      issues.forEach((o) => console.log(o));
      totalIssues += issues.length;
    } else {
      console.log(`  ✓ No issues`);
    }
    console.log();
  }

  console.log(totalIssues === 0
    ? '✓ All clear — no issues found.'
    : `⚠ ${totalIssues} issue(s) found.`);

  process.exit(totalIssues > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
