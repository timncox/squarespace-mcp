import { ContentSaveClient } from '../src/services/content-save.js';

const client = new ContentSaveClient('grey-yellow-hbxc');
client.loadSessionCookies();

// Read full config
const configResult = await client.getHeaderFooter();
if (!configResult.success || !configResult.config) {
  console.error('Failed:', configResult.error);
  process.exit(1);
}

const config = configResult.config as Record<string, unknown>;
const footer = config.footer as Record<string, unknown>;
const sections = footer.sections as Array<Record<string, unknown>>;

// Find and fix the typo in the HTML
for (const section of sections) {
  const fec = section.fluidEngineContext as Record<string, unknown> | undefined;
  if (!fec) continue;
  const gcs = fec.gridContents as Array<Record<string, unknown>>;
  if (!gcs) continue;
  for (const gc of gcs) {
    const val = (gc.content as Record<string, unknown>)?.value as Record<string, unknown>;
    if (val?.type === 2) {
      const inner = val.value as Record<string, unknown>;
      const html = inner.html as string;
      if (html.includes('mercherstreethospitality')) {
        const fixed = html.replace('mercherstreethospitality', 'mercerstreethospitality');
        inner.html = fixed;
        inner.source = fixed;
        console.log('Fixed typo: mercherstreet → mercerstreet');
      }
    }
  }
}

// Save
const saveResult = await client.saveHeaderFooter(config);
console.log(saveResult.success ? 'Saved!' : `Save failed: ${saveResult.error}`);

// Verify
const verify = await client.getHeaderFooter();
const vFooter = (verify.config as Record<string, unknown>).footer as Record<string, unknown>;
const vSections = vFooter.sections as Array<Record<string, unknown>>;
for (const s of vSections) {
  const fec = s.fluidEngineContext as Record<string, unknown> | undefined;
  if (!fec) continue;
  for (const gc of (fec.gridContents as Array<Record<string, unknown>>)) {
    const val = (gc.content as Record<string, unknown>)?.value as Record<string, unknown>;
    if (val?.type === 2) {
      const html = (val.value as Record<string, unknown>).html as string;
      const links = html.match(/href="([^"]*)"/g);
      console.log('Verified links:', links);
    }
  }
}
