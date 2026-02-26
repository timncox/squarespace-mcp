/**
 * Capture screenshots and metadata for Tim's coding projects.
 * Usage: npx tsx scripts/capture-projects.ts
 */
import { chromium } from 'playwright';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';

const SCREENSHOT_DIR = join(process.cwd(), 'storage', 'uploads', 'project-screenshots');

const PROJECTS = [
  { url: 'https://menu-block.lovable.app/' },
  { url: 'https://webscrapetool.lovable.app' },
  { url: 'https://instadownload.lovable.app' },
  { url: 'https://resourcemap.lovable.app' },
  { url: 'https://prayermap.lovable.app' },
  { url: 'https://timalytics2.netlify.app' },
  { url: 'https://staking.timalytics.com' },
  { url: 'https://bodega.timalytics.com' },
];

async function main() {
  if (!existsSync(SCREENSHOT_DIR)) {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  const results: Array<{ url: string; title: string; screenshotPath: string; pageTitle: string; metaDescription: string }> = [];

  for (const project of PROJECTS) {
    const page = await context.newPage();
    const slug = new URL(project.url).hostname.replace(/\./g, '-');
    const screenshotPath = join(SCREENSHOT_DIR, `${slug}.png`);

    console.log(`\n📸 Visiting ${project.url}...`);

    try {
      await page.goto(project.url, { waitUntil: 'networkidle', timeout: 30000 });
      // Extra wait for JS-heavy apps to render
      await page.waitForTimeout(3000);

      await page.screenshot({ path: screenshotPath, fullPage: false });

      const pageTitle = await page.title();
      const metaDescription = await page.$eval(
        'meta[name="description"]',
        (el) => (el as HTMLMetaElement).content,
      ).catch(() => '');

      // Get visible heading text as fallback
      const h1Text = await page.$eval('h1', (el) => el.textContent?.trim() || '').catch(() => '');

      console.log(`  Title: "${pageTitle}"`);
      console.log(`  H1: "${h1Text}"`);
      console.log(`  Meta: "${metaDescription}"`);
      console.log(`  Screenshot: ${screenshotPath}`);

      results.push({
        url: project.url,
        title: pageTitle,
        screenshotPath,
        pageTitle: h1Text || pageTitle,
        metaDescription,
      });
    } catch (err) {
      console.error(`  ❌ Failed: ${(err as Error).message}`);
      // Try screenshot anyway (might show error page)
      try {
        await page.screenshot({ path: screenshotPath, fullPage: false });
        results.push({
          url: project.url,
          title: slug,
          screenshotPath,
          pageTitle: slug,
          metaDescription: '',
        });
      } catch { /* skip */ }
    }

    await page.close();
  }

  await browser.close();

  // Output JSON summary
  console.log('\n\n=== RESULTS JSON ===');
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
