import { createContentSaveClient } from '../src/services/content-save.js';
import { createMediaUploadClient } from '../src/services/media-upload.js';
import { existsSync } from 'fs';

const subdomain = 'tim-cox';
const imagePaths = [
  'storage/uploads/182c8adf-1ec1-4969-a961-6b65f65cf7db-44250030.jpeg',
  'storage/uploads/131cbe6e-5aee-4725-9557-039dd2f8f9a1-44250005.jpeg',
  'storage/uploads/117eb979-3ce1-4b1d-8636-d4518a466b15-44250035.jpeg',
  'storage/uploads/a1c2f925-e109-4783-925f-b912439c634e-44250002.jpeg',
];

async function main() {
  const client = createContentSaveClient(subdomain);

  // Step 1: Get page IDs
  console.log('Getting page IDs for gallery...');
  const ids = await client.getPageIds('gallery');
  console.log('Page IDs:', ids);

  if (!ids) {
    console.error('Could not find gallery page');
    return;
  }

  // Step 2: Check images exist
  for (const p of imagePaths) {
    console.log(`Image ${p}: ${existsSync(p) ? 'EXISTS' : 'MISSING'}`);
  }

  // Step 3: Try uploading one image
  console.log('\nTrying image upload...');
  const mediaClient = createMediaUploadClient(subdomain);
  try {
    const result = await mediaClient.uploadImages([imagePaths[0]], 1);
    console.log('Upload result:', JSON.stringify(result[0], null, 2));
  } catch (err) {
    console.error('Upload error:', err);
  }

  // Step 4: Get page sections to find the gallery page's sections
  // First we need pageSectionsId - try from GetCollections
  console.log('\nGetting collections...');
  try {
    const response = await fetch(`https://${subdomain}.squarespace.com/api/commondata/GetCollections/`, {
      headers: client.buildHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    const data = await response.json() as Record<string, unknown>;
    const collList = Array.isArray(data.collections ?? data)
      ? (data.collections ?? data) as Record<string, unknown>[]
      : Object.values(data.collections ?? data) as Record<string, unknown>[];

    const gallery = collList.find((c: Record<string, unknown>) =>
      String(c.urlId ?? '').toLowerCase() === 'gallery'
    );
    if (gallery) {
      console.log('Gallery collection found:');
      console.log('  id:', gallery.id);
      console.log('  urlId:', gallery.urlId);
      console.log('  title:', gallery.title);
      // Log all keys to find pageSectionsId-like fields
      console.log('  All keys:', Object.keys(gallery));
    }
  } catch (err) {
    console.error('Collections error:', err);
  }
}

main().catch(console.error);
