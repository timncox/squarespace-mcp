import { createMediaUploadClient } from '../src/services/media-upload.js';

const subdomain = 'tim-cox';
const imagePath = 'storage/uploads/131cbe6e-5aee-4725-9557-039dd2f8f9a1-44250005.jpeg';

async function main() {
  const client = createMediaUploadClient(subdomain);

  console.log('Uploading image...');
  const results = await client.uploadImages([imagePath], 1);
  const result = results[0];

  console.log('\nFull upload result:');
  console.log(JSON.stringify(result, null, 2));

  console.log('\nHas assetUrl:', !!result.assetUrl);
  console.log('Has assetId:', !!result.assetId);
  console.log('Success:', result.success);
}

main().catch(console.error);
