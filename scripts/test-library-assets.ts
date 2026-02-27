import { createMediaUploadClient } from '../src/services/media-upload.js';

const subdomain = 'tim-cox';

async function main() {
  const client = createMediaUploadClient(subdomain) as unknown as {
    globalCookieHeader: string;
    libraryId: string;
    authorize(): Promise<void>;
  };

  // Authorize first
  await client.authorize();

  const libraryId = client.libraryId;
  console.log('Library ID:', libraryId);

  // Try listing recent assets in the library
  const listUrl = `https://media.squarespace.com/api/v1/library/${libraryId}/assets?limit=5&sortBy=dateUploaded&sortOrder=desc`;
  const response = await fetch(listUrl, {
    headers: {
      Cookie: client.globalCookieHeader,
      Origin: `https://${subdomain}.squarespace.com`,
      Referer: `https://${subdomain}.squarespace.com/`,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
  });

  console.log('List response status:', response.status);
  const data = await response.json();
  console.log('Assets:', JSON.stringify(data, null, 2).substring(0, 2000));
}

main().catch(console.error);
