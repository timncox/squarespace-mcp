/**
 * Test the MediaUploadClient by uploading a real image to grey-yellow-hbxc.
 *
 * Usage:
 *   npx tsx scripts/test-media-upload.ts
 *   npx tsx scripts/test-media-upload.ts --site tim-cox --library-id abc123
 *   npx tsx scripts/test-media-upload.ts --file /path/to/image.png
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { join, resolve } from 'path';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { createMediaUploadClient } from '../src/services/media-upload.js';

// ── CLI Args ────────────────────────────────────────────────────────────────

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : 'true';
      flags[key] = value;
      if (value !== 'true') i++;
    }
  }
  return flags;
}

// ── Create a real test image (100x100 red PNG) ──────────────────────────────

function createTestPng(): string {
  const uploadDir = join(process.cwd(), 'storage', 'uploads');
  if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true });

  const testPath = join(uploadDir, 'media-upload-test.png');

  // Create a minimal but valid PNG that Squarespace will accept.
  // The 1x1 PNG failed with "ImageUnableToProcess" so we need something bigger.
  // This creates a valid 100x100 red PNG using raw IDAT.
  // For simplicity, we'll create a proper PNG using canvas if available,
  // or fall back to a known-good approach.

  // Approach: create a BMP-style uncompressed image and convert.
  // Actually, let's just check if we have a real image already in the project.
  const candidates = [
    join(process.cwd(), 'storage', 'project-screenshots', 'menu-block.png'),
    join(process.cwd(), 'storage', 'screenshots'),
  ];

  // Find any existing PNG in screenshots
  for (const candidate of candidates) {
    if (existsSync(candidate) && !candidate.endsWith('/')) {
      console.log(`  Using existing image: ${candidate}`);
      return candidate;
    }
  }

  // Check screenshots directory for any PNG
  const screenshotDir = join(process.cwd(), 'storage', 'screenshots');
  if (existsSync(screenshotDir)) {
    const { readdirSync } = require('fs');
    const files = readdirSync(screenshotDir) as string[];
    const png = files.find((f: string) => f.endsWith('.png'));
    if (png) {
      const path = join(screenshotDir, png);
      console.log(`  Using screenshot: ${path}`);
      return path;
    }
  }

  // Create a valid 10x10 solid-color PNG as last resort
  // We'll use the zlib deflate to create a proper IDAT chunk
  console.log('  Creating test PNG (10x10 red)...');

  // This is a pre-built valid 10x10 solid red PNG
  const pngData = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000' +
    '0a0000000a0802000000025b6e880000002549' +
    '444154789c626060f8cf40000630c0000c3080' +
    '01183000036000018300000360000100006c52' +
    '0dcfb90000000049454e44ae426082',
    'hex',
  );
  writeFileSync(testPath, pngData);
  console.log(`  Created test PNG: ${testPath} (${pngData.length} bytes)`);
  return testPath;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const site = flags.site ?? 'grey-yellow-hbxc';
  const libraryId = flags['library-id']; // Auto-discovered if not provided
  const filePath = flags.file;

  console.log('\n========================================');
  console.log('  MEDIA UPLOAD TEST');
  console.log('========================================');
  console.log(`  Site: ${site}`);
  console.log(`  Library ID: ${libraryId ?? '(auto-discover from JWT)'}`);
  console.log('');

  // Create client
  const client = createMediaUploadClient(site, libraryId);
  console.log('  [1/4] Session cookies loaded');

  // Authorize
  console.log('  [2/4] Authorizing with media-api.squarespace.com...');
  await client.authorize();
  console.log('  Authorization successful');

  // Check usage
  console.log('  [3/4] Checking library usage...');
  const usage = await client.getLibraryUsage();
  console.log(`  Images: ${usage.IMAGE.count} (limit: ${usage.IMAGE.limits.count === -1 ? 'unlimited' : usage.IMAGE.limits.count})`);
  console.log(`  Videos: ${usage.VIDEO.count}`);
  console.log(`  Files: ${usage.FILE.count}`);

  // Upload
  const imgPath = filePath ? resolve(filePath) : createTestPng();
  console.log(`\n  [4/4] Uploading: ${imgPath}`);
  const result = await client.uploadImage(imgPath);

  console.log('\n  ======== RESULT ========');
  console.log(`  Status: ${result.status}`);
  console.log(`  Job ID: ${result.jobId}`);
  if (result.assetId) console.log(`  Asset ID: ${result.assetId}`);
  if (result.assetUrl) console.log(`  Asset URL: ${result.assetUrl}`);
  if (result.failureReason) console.log(`  Failure: ${result.failureReason}`);
  console.log('  ========================\n');

  process.exit(result.status === 'success' ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nFatal error: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
