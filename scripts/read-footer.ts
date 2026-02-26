import { ContentSaveClient } from '../src/services/content-save.js';

const client = new ContentSaveClient('grey-yellow-hbxc');
client.loadSessionCookies();

const r = await client.getHeaderFooter();
const footer = (r.config as Record<string, unknown>).footer as Record<string, unknown>;
const sections = footer.sections as Array<Record<string, unknown>>;

for (const section of sections) {
  const fec = section.fluidEngineContext as Record<string, unknown> | undefined;
  if (!fec) continue;
  const gcs = fec.gridContents as Array<Record<string, unknown>>;
  if (!gcs) continue;
  for (const gc of gcs) {
    const content = gc.content as Record<string, unknown>;
    const val = content?.value as Record<string, unknown>;
    if (val?.type === 2) {
      const inner = val.value as Record<string, unknown>;
      console.log('=== CURRENT FOOTER HTML ===');
      console.log(inner.html);
    }
  }
}
