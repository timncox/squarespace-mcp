import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { resolveFilePath } from '../media-upload.js';

describe('resolveFilePath', () => {
  const testDir = join(tmpdir(), `media-upload-test-${randomUUID()}`);

  beforeAll(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true });
  });

  function createFile(name: string): string {
    const p = join(testDir, name);
    writeFileSync(p, 'test');
    return p;
  }

  it('returns the path as-is when it exists', () => {
    const p = createFile('simple.png');
    expect(resolveFilePath(p)).toBe(p);
  });

  it('returns the path as-is for filenames with regular spaces', () => {
    const p = createFile('Screenshot 2026-03-02 at 11.48.55 AM.png');
    expect(resolveFilePath(p)).toBe(p);
  });

  it('resolves non-breaking spaces (U+00A0) to regular spaces', () => {
    const realPath = createFile('Screenshot 2026-03-06 at 10.00.00 AM.png');
    // Simulate a path with non-breaking spaces (U+00A0) as macOS sometimes provides
    const nbspPath = realPath.replace(/ /g, '\u00a0');
    expect(resolveFilePath(nbspPath)).toBe(realPath);
  });

  it('resolves regular spaces to non-breaking spaces when file has them', () => {
    // Create a file with actual non-breaking spaces in the name
    const nbspName = 'Image\u00a0With\u00a0Nbsp.png';
    const realPath = createFile(nbspName);
    // User provides path with regular spaces
    const regularPath = realPath.replace(/\u00a0/g, ' ');
    expect(resolveFilePath(regularPath)).toBe(realPath);
  });

  it('handles thin space (U+2009) in path', () => {
    const realPath = createFile('file with spaces.png');
    const thinSpacePath = realPath.replace(/ /g, '\u2009');
    expect(resolveFilePath(thinSpacePath)).toBe(realPath);
  });

  it('handles narrow no-break space (U+202F) in path', () => {
    const realPath = createFile('another file.png');
    const narrowPath = realPath.replace(/ /g, '\u202f');
    expect(resolveFilePath(narrowPath)).toBe(realPath);
  });

  it('handles figure space (U+2007) in path', () => {
    const realPath = createFile('figure space file.png');
    const figurePath = realPath.replace(/ /g, '\u2007');
    expect(resolveFilePath(figurePath)).toBe(realPath);
  });

  it('returns NFC-normalized path when file does not exist', () => {
    const fakePath = join(testDir, 'no\u00a0such\u00a0file.png');
    const result = resolveFilePath(fakePath);
    // Should return normalized (spaces replaced) even though file doesn't exist
    expect(result).toBe(join(testDir, 'no such file.png'));
    expect(result).not.toContain('\u00a0');
  });

  it('handles mixed Unicode whitespace characters', () => {
    const realPath = createFile('mixed spaces here.png');
    // Mix of non-breaking space and thin space
    const mixedPath = join(testDir, 'mixed\u00a0spaces\u2009here.png');
    expect(resolveFilePath(mixedPath)).toBe(realPath);
  });
});
