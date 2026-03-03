/**
 * Playwright script to capture the network request when setting a featured image
 * on a Squarespace blog post. This reveals the API field name for the thumbnail.
 *
 * Usage:
 *   npx tsx scripts/sniff-featured-image.ts [siteSubdomain]
 *
 * Prerequisites:
 *   - Session cookies in storage/state.json (from refresh-session.ts)
 *   - A blog post that already exists on the site
 *
 * What it does:
 *   1. Opens the site config/pages in the editor
 *   2. Listens for all PUT/POST requests to /api/
 *   3. You manually navigate to a blog post and set the featured image
 *   4. Captures and logs the full request body, highlighting image-related fields
 *   5. Press Ctrl+C — captured data saved to data/featured-image-capture.json
 */

import { chromium, type Request } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const SITE = process.argv[2] || 'grey-yellow-hbxc';
const STORAGE_STATE = path.resolve('storage/state.json');

const IMAGE_FIELDS = [
  'mainImage', 'thumbnailImage', 'leadImage', 'mediaFocalPoint',
  'assetUrl', 'systemDataId', 'mediaId', 'imageId', 'featuredImage',
  'thumbnail', 'heroImage', 'coverImage',
];

async function main() {
  if (!fs.existsSync(STORAGE_STATE)) {
    console.error('No storage state found at', STORAGE_STATE);
    console.error('Run: npm run refresh-session first');
    process.exit(1);
  }

  console.log(`Opening ${SITE}.squarespace.com editor...`);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ storageState: STORAGE_STATE });
  const page = await context.newPage();

  const captured: Array<{ url: string; method: string; body: string; timestamp: number }> = [];

  page.on('request', (req: Request) => {
    const url = req.url();
    if (url.includes('/api/') && ['PUT', 'POST', 'PATCH'].includes(req.method())) {
      const postData = req.postData();
      captured.push({ url, method: req.method(), body: postData || '', timestamp: Date.now() });

      console.log(`\n=== ${req.method()} ${url} ===`);
      if (postData) {
        try {
          const parsed = JSON.parse(postData);
          const found = IMAGE_FIELDS.filter(f => f in parsed);
          if (found.length > 0) {
            console.log('*** FOUND IMAGE FIELDS:', found.join(', '), '***');
          }
          console.log(JSON.stringify(parsed, null, 2));
        } catch {
          console.log(postData.slice(0, 500));
        }
      }
    }
  });

  const configUrl = `https://${SITE}.squarespace.com/config/pages`;
  await page.goto(configUrl, { waitUntil: 'networkidle' });

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  MANUAL STEPS:                                              ║');
  console.log('║  1. Navigate to a blog post in the editor                   ║');
  console.log('║  2. Click the thumbnail/featured image area                 ║');
  console.log('║  3. Select or upload an image                               ║');
  console.log('║  4. Save the post                                           ║');
  console.log('║  5. Check this terminal for captured API requests            ║');
  console.log('║  6. Press Ctrl+C when done                                  ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  process.on('SIGINT', () => {
    const outPath = path.resolve('data/featured-image-capture.json');
    fs.writeFileSync(outPath, JSON.stringify(captured, null, 2));
    console.log(`\nCaptured ${captured.length} API requests → ${outPath}`);
    browser.close().then(() => process.exit(0));
  });

  await new Promise(() => {});
}

main().catch(console.error);
