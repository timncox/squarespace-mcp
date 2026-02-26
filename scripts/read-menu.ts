import { ContentSaveClient } from '../src/services/content-save.js';

async function main() {
  const subdomain = 'grey-yellow-hbxc';
  const client = new ContentSaveClient(subdomain);
  client.loadSessionCookies();

  // Get pageSectionsId via authenticated site API
  const siteUrl = `https://${subdomain}.squarespace.com`;
  const cookieHeader = (client as any).siteCookieHeader;

  // Try the site map/navigation endpoint to find the menus page
  const navResp = await fetch(`${siteUrl}/api/commondata/GetContentInfo`, {
    headers: { 'Cookie': cookieHeader },
  });

  if (navResp.ok) {
    const navData = await navResp.json() as any;
    console.log('Nav keys:', Object.keys(navData));
  }

  // Try direct page API — the authenticated version
  const pageResp = await fetch(`${siteUrl}/menus?format=json-pretty`, {
    headers: { 'Cookie': cookieHeader },
  });

  if (pageResp.ok) {
    const pageData = await pageResp.json() as any;
    // Walk the structure to find pageSectionsId
    const psId = pageData.collection?.pageSectionsId
      || pageData.item?.pageSectionsId
      || pageData.mainContent?.pageSectionsId;
    console.log('pageSectionsId:', psId);

    if (!psId) {
      // Dump top-level keys to find it
      console.log('Top keys:', Object.keys(pageData));
      if (pageData.collection) console.log('collection keys:', Object.keys(pageData.collection));
      if (pageData.item) console.log('item keys:', Object.keys(pageData.item));
      // Look for it in website.sitePages
      const pages = pageData.website?.sitePages || [];
      const menusPage = pages.find((p: any) => p.urlId === 'menus');
      if (menusPage) {
        console.log('Found menus page, pageSectionsId:', menusPage.pageSectionsId);
        await readMenu(client, menusPage.pageSectionsId);
        return;
      }
    } else {
      await readMenu(client, psId);
      return;
    }
  } else {
    console.log('Page fetch failed:', pageResp.status);
  }

  // Fallback: try the website config API
  const siteResp = await fetch(`${siteUrl}/api/website/settings`, {
    headers: { 'Cookie': cookieHeader },
  });
  if (siteResp.ok) {
    const siteData = await siteResp.json() as any;
    const pages = siteData.website?.sitePages || [];
    const menusPage = pages.find((p: any) => p.urlId === 'menus');
    if (menusPage) {
      console.log('Found via settings, pageSectionsId:', menusPage.pageSectionsId);
      await readMenu(client, menusPage.pageSectionsId);
    }
  }
}

async function readMenu(client: ContentSaveClient, pageSectionsId: string) {
  const sections = await client.getPageSections(pageSectionsId);

  let found = false;
  for (const section of sections) {
    const blocks = (section as any).data?.layout?.gridContents || [];
    for (const block of blocks) {
      if (block.type === 54) {
        found = true;
        console.log('=== MENU BLOCK FOUND ===');
        console.log('Block ID:', block.id);
        const val = block.value;
        if (val) {
          console.log('Value keys:', Object.keys(val));
          const menuText = val.menu || val.text || JSON.stringify(val);
          if (typeof menuText === 'string') {
            console.log('\nFull content:\n');
            console.log(menuText);
          } else {
            console.log('\nValue (JSON):\n');
            console.log(JSON.stringify(val, null, 2).substring(0, 5000));
          }
        }
      }
    }
  }
  if (!found) {
    console.log('No menu block (type 54) found. Block types present:');
    for (const section of sections) {
      const blocks = (section as any).data?.layout?.gridContents || [];
      blocks.forEach((b: any) => console.log('  type:', b.type, 'id:', b.id?.substring(0, 12)));
    }
  }
}

main().catch(e => console.error('Error:', e.message));
