/**
 * Fix Smyth Tavern footer to match smythtavern.com format including links.
 *
 * Usage: npx tsx scripts/fix-footer-api.ts
 */

import { ContentSaveClient } from '../src/services/content-save.js';

const SITE_SUBDOMAIN = 'grey-yellow-hbxc';

async function main() {
  console.log('=== Fix Smyth Tavern Footer ===\n');

  const client = new ContentSaveClient(SITE_SUBDOMAIN);
  client.loadSessionCookies();

  // Step 1: GET the full header-footer config
  console.log('Step 1: Reading header-footer config...');
  const configResult = await client.getHeaderFooter();

  if (!configResult.success || !configResult.config) {
    console.error('Failed to read config:', configResult.error);
    process.exit(1);
  }

  const config = configResult.config as Record<string, unknown>;
  const footer = config.footer as Record<string, unknown>;
  const footerSections = footer.sections as Array<Record<string, unknown>>;

  if (!footerSections?.length) {
    console.error('No footer sections found');
    process.exit(1);
  }

  // The correct footer HTML matching smythtavern.com format WITH links
  // Hours updated per user request: Monday - Sunday | 12PM-12AM
  const correctHtml = [
    '<p class="" style="white-space:pre-wrap;text-align:center;">GIFT CARDS</p>',
    '<p class="" style="white-space:pre-wrap;text-align:center;"><a href="https://mercherstreethospitality.webgiftcardsales.com/" target="_blank">Purchase a Gift Card</a></p>',
    '<p class="" style="white-space:pre-wrap;text-align:center;"><a href="mailto:INFO@SMYTHTAVERN.COM">INFO@SMYTHTAVERN.COM</a></p>',
    '<p class="" style="white-space:pre-wrap;text-align:center;">Monday - Sunday | 12PM-12AM</p>',
    '<p class="" style="white-space:pre-wrap;text-align:center;">(646) 813-9090</p>',
    '<p class="" style="white-space:pre-wrap;text-align:center;">85 West Broadway on the corner of Chambers Street</p>',
  ].join('');

  // Find and update the text block
  let updated = false;
  for (const section of footerSections) {
    const fec = section.fluidEngineContext as Record<string, unknown> | undefined;
    if (!fec) continue;
    const gridContents = fec.gridContents as Array<Record<string, unknown>>;
    if (!gridContents) continue;

    for (const gc of gridContents) {
      const content = gc.content as Record<string, unknown>;
      const val = content?.value as Record<string, unknown>;
      if (val?.type === 2) {
        const inner = val.value as Record<string, unknown>;
        if (inner) {
          const oldHtml = inner.html as string;
          console.log(`  Current: ${oldHtml.replace(/<[^>]+>/g, '').substring(0, 100)}...`);
          console.log(`\n  Setting new content with links...`);
          inner.html = correctHtml;
          inner.source = correctHtml;
          updated = true;
          break;
        }
      }
    }
    if (updated) break;
  }

  if (!updated) {
    console.error('No text block found in footer');
    process.exit(1);
  }

  // Step 2: Save
  console.log('\nStep 2: Saving...');
  const saveResult = await client.saveHeaderFooter(config);

  if (!saveResult.success) {
    console.error('Failed to save:', saveResult.error);
    process.exit(1);
  }
  console.log('  Saved successfully!');

  // Step 3: Verify
  console.log('\nStep 3: Verifying...');
  const verify = await client.getHeaderFooter();
  if (verify.success && verify.config) {
    const vFooter = (verify.config as Record<string, unknown>).footer as Record<string, unknown>;
    const vSections = vFooter?.sections as Array<Record<string, unknown>>;
    if (vSections) {
      for (const section of vSections) {
        const fec = section.fluidEngineContext as Record<string, unknown> | undefined;
        if (!fec) continue;
        const gcs = fec.gridContents as Array<Record<string, unknown>>;
        if (!gcs) continue;
        for (const gc of gcs) {
          const content = gc.content as Record<string, unknown>;
          const val = content?.value as Record<string, unknown>;
          if (val?.type === 2) {
            const inner = val.value as Record<string, unknown>;
            const html = inner?.html as string;
            console.log('\n  Verified HTML:');
            console.log(`  ${html}`);

            // Check for links
            const linkMatches = html.match(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g);
            if (linkMatches) {
              console.log('\n  Links found:');
              for (const link of linkMatches) {
                const hrefMatch = link.match(/href="([^"]*)"/);
                const textMatch = link.match(/>([^<]*)</);
                console.log(`    "${textMatch?.[1]}" → ${hrefMatch?.[1]}`);
              }
            }
          }
        }
      }
    }
  }

  console.log('\n=== Done! ===');
}

main().catch(console.error);
