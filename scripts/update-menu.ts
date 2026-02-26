/**
 * Script to read current menu block content and update it with the full menu from /tmp/menu-content.txt.
 * Uses Content Save API to find the menu block, then the browser's editMenuBlock handler
 * via a CLI agent call with the complete menu content.
 */

import { ContentSaveClient } from '../src/services/content-save.js';
import { readFileSync } from 'fs';

const subdomain = 'grey-yellow-hbxc';

async function main() {
  const client = new ContentSaveClient(subdomain);
  client.loadSessionCookies();

  const siteUrl = `https://${subdomain}.squarespace.com`;
  const cookieHeader = (client as any).siteCookieHeader;

  // Method 1: Try the page's ?format=json-pretty to find the pageSectionsId
  // The pageSectionsId is on the collection's mainContent object
  const pageResp = await fetch(`${siteUrl}/menus?format=json-pretty`, {
    headers: { 'Cookie': cookieHeader },
  });

  if (!pageResp.ok) {
    console.error('Failed to fetch page data:', pageResp.status);
    return;
  }

  const pageData = await pageResp.json() as any;

  // Try all possible locations for pageSectionsId
  let psId: string | undefined;

  // Direct on collection
  psId = pageData.collection?.pageSectionsId;

  // On mainContent
  if (!psId) psId = pageData.mainContent?.pageSectionsId;

  // On the collection's mainContent
  if (!psId) psId = pageData.collection?.mainContent?.pageSectionsId;

  // In website.sitePages array
  if (!psId) {
    const pages = pageData.website?.sitePages || [];
    const menusPage = pages.find((p: any) => p.urlId === 'menus');
    if (menusPage) psId = menusPage.pageSectionsId;
  }

  // Deep search: look through all top-level values
  if (!psId) {
    console.log('Searching for pageSectionsId in response...');
    const json = JSON.stringify(pageData);
    const match = json.match(/"pageSectionsId"\s*:\s*"([^"]+)"/);
    if (match) {
      psId = match[1];
      console.log('Found via regex:', psId);
    }
  }

  if (!psId) {
    console.error('Could not find pageSectionsId. Dumping collection:');
    console.log(JSON.stringify(pageData.collection, null, 2).substring(0, 3000));
    return;
  }

  console.log('pageSectionsId:', psId);

  // Read the current menu block content
  const sections = await client.getPageSections(psId);

  let menuBlockFound = false;
  for (const section of sections) {
    const blocks = (section as any).data?.layout?.gridContents || [];
    for (const block of blocks) {
      if (block.type === 54) {
        menuBlockFound = true;
        console.log('\n=== MENU BLOCK FOUND ===');
        console.log('Block ID:', block.id);
        console.log('Section ID:', (section as any).id);

        const val = block.value;
        if (val) {
          console.log('Value keys:', Object.keys(val));
          // Menu blocks typically store content in value.menu or value.html
          const content = val.menu || val.html || val.text;
          if (content) {
            // Show first 500 chars
            console.log('\nCurrent content preview (first 500 chars):');
            console.log(typeof content === 'string' ? content.substring(0, 500) : JSON.stringify(content).substring(0, 500));
            console.log('\n... (total length:', typeof content === 'string' ? content.length : JSON.stringify(content).length, ')');
          } else {
            console.log('\nFull value:');
            console.log(JSON.stringify(val, null, 2).substring(0, 3000));
          }
        }
      }
    }
  }

  if (!menuBlockFound) {
    console.log('\nNo menu block (type 54) found. All block types:');
    for (const section of sections) {
      console.log('Section:', (section as any).id?.substring(0, 12));
      const blocks = (section as any).data?.layout?.gridContents || [];
      blocks.forEach((b: any) => console.log('  type:', b.type, 'id:', b.id?.substring(0, 12)));
    }
  }
}

main().catch(e => console.error('Error:', e.message));
