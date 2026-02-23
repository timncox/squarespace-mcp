import dotenv from 'dotenv';
dotenv.config({ override: true });

/**
 * Test WhatsApp Business Cloud API connectivity.
 *
 * Sends three test messages to Tim:
 * 1. Plain text message
 * 2. Interactive button message
 * 3. (Optional) Image message — only if a test screenshot exists
 *
 * Usage:
 *   npx tsx scripts/test-whatsapp.ts
 *
 * Requires: WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN, TIM_WHATSAPP_NUMBER in .env
 */

import { sendToTim, sendButtonsToTim, sendImageToTim } from '../src/services/whatsapp.js';
import { existsSync } from 'fs';
import { join } from 'path';

async function main(): Promise<void> {
  console.log('=== WhatsApp API Connectivity Test ===\n');

  // Check env vars
  const required = ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN', 'TIM_WHATSAPP_NUMBER'];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.error(`❌ Missing environment variables: ${missing.join(', ')}`);
    console.error('   Set these in your .env file before running this test.');
    process.exit(1);
  }

  console.log('✅ Environment variables found\n');
  console.log(`   Phone Number ID: ${process.env.WHATSAPP_PHONE_NUMBER_ID}`);
  console.log(`   Tim's number:    ${process.env.TIM_WHATSAPP_NUMBER}`);
  console.log(`   Access token:    ${process.env.WHATSAPP_ACCESS_TOKEN?.substring(0, 20)}...\n`);

  // Test 1: Send text message
  console.log('1. Sending text message...');
  try {
    const textId = await sendToTim('🤖 Squarespace Helper test message. If you see this, WhatsApp API is working!');
    console.log(`   ✅ Text sent! ID: ${textId}\n`);
  } catch (err) {
    console.error(`   ❌ Text failed: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }

  // Test 2: Send interactive buttons
  console.log('2. Sending interactive buttons...');
  try {
    const buttonId = await sendButtonsToTim(
      '🤖 Test: Can you tap a button?',
      [
        { id: 'test_yes', title: 'Yes, it works!' },
        { id: 'test_no', title: 'Nope' },
      ],
    );
    console.log(`   ✅ Buttons sent! ID: ${buttonId}\n`);
  } catch (err) {
    console.error(`   ❌ Buttons failed: ${err instanceof Error ? err.message : err}\n`);
    // Continue — buttons might not work with test numbers
  }

  // Test 3: Send image (only if a test screenshot exists)
  const testScreenshot = join(process.cwd(), 'screenshots');
  const screenshotFiles = existsSync(testScreenshot)
    ? (await import('fs')).readdirSync(testScreenshot).filter((f: string) => f.endsWith('.png'))
    : [];

  if (screenshotFiles.length > 0) {
    const imagePath = join(testScreenshot, screenshotFiles[0]);
    console.log(`3. Sending image: ${screenshotFiles[0]}...`);
    try {
      const imageId = await sendImageToTim(imagePath, '🤖 Test screenshot');
      console.log(`   ✅ Image sent! ID: ${imageId}\n`);
    } catch (err) {
      console.error(`   ❌ Image failed: ${err instanceof Error ? err.message : err}\n`);
    }
  } else {
    console.log('3. Skipping image test — no screenshots found in ./screenshots/\n');
  }

  console.log('=== Test Complete ===');
  console.log('\nCheck your WhatsApp for the test messages.');
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
