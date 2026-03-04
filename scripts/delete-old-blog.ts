import { ContentSaveClient } from '../src/services/content-save.js';

async function main() {
  const client = new ContentSaveClient('grey-yellow-hbxc');
  client.loadSessionCookies();

  const headers = (client as any).buildHeaders();

  // Get full site layout
  const resp = await fetch('https://grey-yellow-hbxc.squarespace.com/api/commondata/GetSiteLayout', { headers });
  const data = await resp.json() as any;

  const mainNav = data.layout?.[0]?.links || [];
  console.log('Current mainNav:', mainNav.map((p: any) => p.title + ' (' + p.urlId + ')').join(', '));

  // Build new nav items WITHOUT the old Blog page (type 10, urlId 'blog')
  const filteredItems = mainNav.filter((p: any) => {
    if (p.urlId === 'blog' && p.collectionType === 10) return false;
    return true;
  });
  console.log('Filtered mainNav:', filteredItems.map((p: any) => p.title + ' (' + p.urlId + ')').join(', '));

  // Use updateNavigation to save the new list
  const navItems = filteredItems.map((p: any) => ({
    collectionId: p.collectionId,
    title: p.title,
    urlId: p.urlId,
  }));

  const result = await client.updateNavigation('mainNav', navItems);
  console.log('Update result:', JSON.stringify(result));
}
main().catch(e => console.error(e.message));
