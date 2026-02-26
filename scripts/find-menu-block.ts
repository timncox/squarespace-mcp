import { ContentSaveClient } from '../src/services/content-save.js';

async function main() {
  const subdomain = 'grey-yellow-hbxc';
  const client = new ContentSaveClient(subdomain);
  client.loadSessionCookies();

  const siteUrl = `https://${subdomain}.squarespace.com`;
  const headers = (client as any).buildHeaders();

  // Load the actual menus page HTML (not config) to find data-page-sections
  console.log('Fetching menus page HTML...');
  const pageResp = await fetch(`${siteUrl}/menus`, { headers });
  if (!pageResp.ok) {
    console.error('Page fetch failed:', pageResp.status);
    return;
  }

  const html = await pageResp.text();
  console.log('HTML length:', html.length);

  // Search for data-page-sections attribute
  const psMatch = html.match(/data-page-sections="([^"]+)"/);
  if (psMatch) {
    console.log('Found pageSectionsId:', psMatch[1]);
    await readSections(client, psMatch[1]);
    return;
  }

  // Search for any 24-char hex ID patterns near "pageSections"
  const allMatches = [...html.matchAll(/[pP]age[sS]ections[^"]*"([a-f0-9]{24})"/gi)];
  if (allMatches.length > 0) {
    for (const m of allMatches) {
      console.log('Found possible ID:', m[1]);
    }
    await readSections(client, allMatches[0][1]);
    return;
  }

  // Also search for any data- attributes with 24-char hex IDs
  const dataMatches = [...html.matchAll(/data-[a-z-]+=["']([a-f0-9]{24})["']/gi)];
  console.log(`Found ${dataMatches.length} data attributes with hex IDs:`);
  for (const m of dataMatches) {
    console.log(`  ${m[0]}`);
  }

  // Try each one as pageSectionsId
  for (const m of dataMatches) {
    const id = m[1];
    console.log(`\nTrying ${id} as pageSectionsId...`);
    try {
      const sections = await client.getPageSections(id);
      console.log(`Success! ${sections.length} sections found`);
      await readSections(client, id);
      return;
    } catch {
      console.log('  Failed');
    }
  }

  // Last resort: search for any 24-char hex IDs in embedded JSON
  const jsonIds = [...new Set([...html.matchAll(/[a-f0-9]{24}/g)].map(m => m[0]))];
  console.log(`\nFound ${jsonIds.length} unique 24-char hex IDs. Trying each...`);
  for (const id of jsonIds.slice(0, 20)) {
    try {
      const sections = await client.getPageSections(id);
      if (sections.length > 0) {
        console.log(`Found! ID ${id} has ${sections.length} sections`);
        await readSections(client, id);
        return;
      }
    } catch {
      // skip
    }
  }
  console.log('Could not find pageSectionsId');
}

async function readSections(client: ContentSaveClient, psId: string) {
  console.log(`\nReading sections for pageSectionsId: ${psId}`);
  const data = await client.getPageSections(psId);
  const sections = data.sections || [];
  console.log(`Found ${sections.length} sections`);

  for (const section of sections) {
    const s = section as any;
    const blocks = s.fluidEngineContext?.gridContents || s.data?.layout?.gridContents || [];
    console.log(`\nSection ${s.id?.substring(0, 12)} — ${blocks.length} blocks`);

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const content = block.content?.value;
      const type = content?.type;
      const defName = content?.definitionName;
      console.log(`  Block ${i}: type=${type} def=${defName} id=${content?.value?.id?.substring(0, 12) || content?.id?.substring(0, 12)}`);

      if (type === 54 || type === 18 || defName?.includes('menu')) {
        console.log('  >>> MENU BLOCK <<<');
        const val = content?.value;
        if (val) {
          console.log('  Value keys:', Object.keys(val));
          const htmlContent = val.html || val.menu || val.text;
          if (htmlContent && typeof htmlContent === 'string') {
            console.log(`  HTML content length: ${htmlContent.length}`);
            console.log('  First 500 chars:', htmlContent.substring(0, 500));
          } else {
            console.log('  Full value (first 3000 chars):', JSON.stringify(val, null, 2).substring(0, 3000));
          }
        }
      }
    }
  }
}

main().catch(e => console.error('Error:', e.message));
