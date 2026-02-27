import { createMediaUploadClient } from '../src/services/media-upload.js';

const subdomain = 'tim-cox';

async function main() {
  const client = createMediaUploadClient(subdomain);

  // Upload image and capture the full result including the job response
  console.log('Uploading image...');
  const results = await client.uploadImages(
    ['storage/uploads/131cbe6e-5aee-4725-9557-039dd2f8f9a1-44250005.jpeg'],
    1,
  );

  console.log('\nFull result object keys:', Object.keys(results[0]));
  console.log('Full result:', JSON.stringify(results[0], null, 2));

  // Check what the status API returns — use the internal method
  // Since we can't access private methods, let's check the raw job status
  if (results[0].jobId) {
    const jobId = results[0].jobId;
    console.log('\nManually checking job status...');

    // Build the status URL from the public API base
    const statusUrl = `https://media.squarespace.com/api/v1/jobs/image/status?job-list=${encodeURIComponent(jobId)}`;

    // Get global cookies from the client (they're on the prototype chain)
    const response = await fetch(statusUrl, {
      headers: {
        Origin: `https://${subdomain}.squarespace.com`,
        Referer: `https://${subdomain}.squarespace.com/`,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      },
    });

    console.log('Status response status:', response.status);
    const text = await response.text();
    console.log('Status response (raw):', text.substring(0, 500));
  }
}

main().catch(console.error);
