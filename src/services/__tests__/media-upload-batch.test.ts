/**
 * Tests for MediaUploadClient.uploadImages() batch upload
 * and WhatsApp image group buffering.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MediaUploadClient, type BatchUploadResult, type MediaUploadResult } from '../media-upload.js';
import {
  bufferImageMessage,
  onImageGroupComplete,
  clearImageGroupBuffers,
  type IncomingWhatsAppMessage,
  type ImageGroupCallback,
} from '../whatsapp.js';

// ── MediaUploadClient.uploadImages() ────────────────────────────────────────

describe('MediaUploadClient.uploadImages()', () => {
  let client: MediaUploadClient;
  let uploadImageSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = new MediaUploadClient('test-site', 'lib-123');
    // Mock ensureAuthorized to skip auth
    vi.spyOn(client as unknown as { ensureAuthorized: () => Promise<void> }, 'ensureAuthorized')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockUploadImage(results: Map<string, MediaUploadResult | Error>) {
    uploadImageSpy = vi.spyOn(client, 'uploadImage').mockImplementation(async (filePath: string) => {
      const result = results.get(filePath);
      if (result instanceof Error) throw result;
      return result as MediaUploadResult;
    });
  }

  it('returns empty array for empty input', async () => {
    const results = await client.uploadImages([]);
    expect(results).toEqual([]);
  });

  it('uploads a single image successfully', async () => {
    mockUploadImage(new Map([
      ['/path/a.jpg', { jobId: 'j1', libraryId: 'lib-123', status: 'success', assetUrl: 'https://img.sqsp.com/a.jpg', assetId: 'asset-1' }],
    ]));

    const results = await client.uploadImages(['/path/a.jpg']);
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].originalPath).toBe('/path/a.jpg');
    expect(results[0].assetUrl).toBe('https://img.sqsp.com/a.jpg');
    expect(results[0].assetId).toBe('asset-1');
    expect(results[0].jobId).toBe('j1');
  });

  it('uploads multiple images successfully preserving order', async () => {
    // Add delays to verify order is preserved even with different completion times
    const uploadImpl = vi.fn().mockImplementation(async (filePath: string) => {
      const delay = filePath.includes('b.jpg') ? 50 : 10; // b.jpg is slower
      await new Promise((r) => setTimeout(r, delay));
      return {
        jobId: `job-${filePath}`,
        libraryId: 'lib-123',
        status: 'success' as const,
        assetUrl: `https://img.sqsp.com/${filePath.split('/').pop()}`,
        assetId: `asset-${filePath.split('/').pop()}`,
      };
    });
    vi.spyOn(client, 'uploadImage').mockImplementation(uploadImpl);

    const results = await client.uploadImages(['/path/a.jpg', '/path/b.jpg', '/path/c.jpg']);

    expect(results).toHaveLength(3);
    expect(results[0].originalPath).toBe('/path/a.jpg');
    expect(results[1].originalPath).toBe('/path/b.jpg');
    expect(results[2].originalPath).toBe('/path/c.jpg');
    expect(results.every((r) => r.success)).toBe(true);
  });

  it('handles partial failures gracefully', async () => {
    mockUploadImage(new Map([
      ['/path/a.jpg', { jobId: 'j1', libraryId: 'lib-123', status: 'success', assetUrl: 'https://img.sqsp.com/a.jpg' }],
      ['/path/b.jpg', new Error('Upload failed: 500 Internal Server Error')],
      ['/path/c.jpg', { jobId: 'j3', libraryId: 'lib-123', status: 'success', assetUrl: 'https://img.sqsp.com/c.jpg' }],
    ]));

    const results = await client.uploadImages(['/path/a.jpg', '/path/b.jpg', '/path/c.jpg']);

    expect(results).toHaveLength(3);
    expect(results[0].success).toBe(true);
    expect(results[0].assetUrl).toBe('https://img.sqsp.com/a.jpg');

    expect(results[1].success).toBe(false);
    expect(results[1].originalPath).toBe('/path/b.jpg');
    expect(results[1].error).toContain('500');

    expect(results[2].success).toBe(true);
  });

  it('handles all uploads failing', async () => {
    mockUploadImage(new Map([
      ['/path/a.jpg', new Error('Auth expired')],
      ['/path/b.jpg', new Error('Auth expired')],
    ]));

    const results = await client.uploadImages(['/path/a.jpg', '/path/b.jpg']);

    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.success)).toBe(true);
    expect(results.every((r) => r.error === 'Auth expired')).toBe(true);
  });

  it('handles API-reported failures (status: failed)', async () => {
    mockUploadImage(new Map([
      ['/path/a.jpg', { jobId: 'j1', libraryId: 'lib-123', status: 'failed', failureReason: 'UNSUPPORTED_FORMAT' }],
    ]));

    const results = await client.uploadImages(['/path/a.jpg']);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBe('UNSUPPORTED_FORMAT');
  });

  it('respects concurrency limit of 3', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    vi.spyOn(client, 'uploadImage').mockImplementation(async (filePath: string) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 30));
      concurrent--;
      return { jobId: `job-${filePath}`, libraryId: 'lib-123', status: 'success' as const, assetUrl: `https://img/${filePath}` };
    });

    // Upload 6 images with default concurrency of 3
    const paths = Array.from({ length: 6 }, (_, i) => `/path/img${i}.jpg`);
    const results = await client.uploadImages(paths, 3);

    expect(results).toHaveLength(6);
    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(maxConcurrent).toBeGreaterThan(1); // Actually ran in parallel
  });

  it('respects custom concurrency limit', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    vi.spyOn(client, 'uploadImage').mockImplementation(async (filePath: string) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent--;
      return { jobId: `job-${filePath}`, libraryId: 'lib-123', status: 'success' as const, assetUrl: `https://img/${filePath}` };
    });

    const paths = Array.from({ length: 5 }, (_, i) => `/path/img${i}.jpg`);
    await client.uploadImages(paths, 2);

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('handles concurrency=1 (serial uploads)', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    vi.spyOn(client, 'uploadImage').mockImplementation(async (filePath: string) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      concurrent--;
      return { jobId: `job-${filePath}`, libraryId: 'lib-123', status: 'success' as const, assetUrl: `https://img/${filePath}` };
    });

    const paths = ['/path/a.jpg', '/path/b.jpg', '/path/c.jpg'];
    await client.uploadImages(paths, 1);

    expect(maxConcurrent).toBe(1);
  });

  it('handles more images than concurrency limit', async () => {
    vi.spyOn(client, 'uploadImage').mockImplementation(async (filePath: string) => {
      await new Promise((r) => setTimeout(r, 5));
      return { jobId: `job-${filePath}`, libraryId: 'lib-123', status: 'success' as const, assetUrl: `https://img/${filePath}` };
    });

    const paths = Array.from({ length: 10 }, (_, i) => `/path/img${i}.jpg`);
    const results = await client.uploadImages(paths, 3);

    expect(results).toHaveLength(10);
    expect(results.every((r) => r.success)).toBe(true);
    // Verify order preserved
    results.forEach((r, i) => {
      expect(r.originalPath).toBe(`/path/img${i}.jpg`);
    });
  });

  it('preserves result order when some uploads fail', async () => {
    vi.spyOn(client, 'uploadImage').mockImplementation(async (filePath: string) => {
      const idx = parseInt(filePath.match(/img(\d+)/)?.[1] ?? '0');
      await new Promise((r) => setTimeout(r, Math.random() * 20));
      if (idx % 2 === 0) throw new Error(`Fail-${idx}`);
      return { jobId: `job-${idx}`, libraryId: 'lib-123', status: 'success' as const, assetUrl: `https://img/${idx}` };
    });

    const paths = Array.from({ length: 5 }, (_, i) => `/path/img${i}.jpg`);
    const results = await client.uploadImages(paths, 3);

    expect(results).toHaveLength(5);
    expect(results[0].success).toBe(false); // img0 — even, fails
    expect(results[1].success).toBe(true);  // img1 — odd, succeeds
    expect(results[2].success).toBe(false); // img2 — even, fails
    expect(results[3].success).toBe(true);  // img3 — odd, succeeds
    expect(results[4].success).toBe(false); // img4 — even, fails
  });
});

// ── Image Group Buffering ──────────────────────────────────────────────────

describe('WhatsApp image group buffering', () => {
  beforeEach(() => {
    clearImageGroupBuffers();
    vi.useFakeTimers();
  });

  afterEach(() => {
    clearImageGroupBuffers();
    vi.useRealTimers();
  });

  function makeImageMsg(from: string, mediaId: string, body = ''): IncomingWhatsAppMessage {
    return {
      waMessageId: `msg-${mediaId}`,
      from,
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'image',
      body,
      mediaId,
    };
  }

  it('buffers image messages when callback is registered', () => {
    const callback = vi.fn();
    onImageGroupComplete(callback);

    const msg = makeImageMsg('user1', 'media-1', 'Check this');
    const buffered = bufferImageMessage(msg);

    expect(buffered).toBe(true);
    expect(callback).not.toHaveBeenCalled();
  });

  it('does not buffer non-image messages', () => {
    onImageGroupComplete(vi.fn());

    const msg: IncomingWhatsAppMessage = {
      waMessageId: 'msg-text',
      from: 'user1',
      timestamp: '123',
      type: 'text',
      body: 'hello',
    };

    expect(bufferImageMessage(msg)).toBe(false);
  });

  it('does not buffer when no callback is registered', () => {
    const msg = makeImageMsg('user1', 'media-1');
    expect(bufferImageMessage(msg)).toBe(false);
  });

  it('flushes single image after 5s wait', () => {
    const callback = vi.fn();
    onImageGroupComplete(callback);

    bufferImageMessage(makeImageMsg('user1', 'media-1', 'My photo'));

    // Not flushed yet
    vi.advanceTimersByTime(4_999);
    expect(callback).not.toHaveBeenCalled();

    // Flush after 5s
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(
      [expect.objectContaining({ mediaId: 'media-1', body: 'My photo' })],
      expect.stringContaining('img-group-'),
    );
  });

  it('groups multiple images from same sender within window', () => {
    const callback = vi.fn();
    onImageGroupComplete(callback);

    bufferImageMessage(makeImageMsg('user1', 'media-1', 'Caption on first'));
    vi.advanceTimersByTime(2_000);
    bufferImageMessage(makeImageMsg('user1', 'media-2'));
    vi.advanceTimersByTime(2_000);
    bufferImageMessage(makeImageMsg('user1', 'media-3'));

    // Not flushed yet
    expect(callback).not.toHaveBeenCalled();

    // Wait for flush (5s after last image)
    vi.advanceTimersByTime(5_000);
    expect(callback).toHaveBeenCalledTimes(1);

    const [messages, groupId] = callback.mock.calls[0];
    expect(messages).toHaveLength(3);
    expect(messages[0].mediaId).toBe('media-1');
    expect(messages[0].body).toBe('Caption on first');
    expect(messages[1].mediaId).toBe('media-2');
    expect(messages[2].mediaId).toBe('media-3');
    expect(groupId).toContain('img-group-');
  });

  it('separates images from different senders', () => {
    const callback = vi.fn();
    onImageGroupComplete(callback);

    bufferImageMessage(makeImageMsg('user1', 'media-1'));
    bufferImageMessage(makeImageMsg('user2', 'media-2'));

    // Flush both after 5s
    vi.advanceTimersByTime(5_000);
    expect(callback).toHaveBeenCalledTimes(2);

    const call1 = callback.mock.calls[0];
    const call2 = callback.mock.calls[1];
    expect(call1[0]).toHaveLength(1);
    expect(call2[0]).toHaveLength(1);
    expect(call1[0][0].mediaId).toBe('media-1');
    expect(call2[0][0].mediaId).toBe('media-2');
  });

  it('starts new group when window expires', () => {
    const callback = vi.fn();
    onImageGroupComplete(callback);

    bufferImageMessage(makeImageMsg('user1', 'media-1'));

    // Advance past the 10s grouping window
    vi.advanceTimersByTime(11_000);

    // First group should be flushed
    expect(callback).toHaveBeenCalledTimes(1);

    // New image starts a new group
    bufferImageMessage(makeImageMsg('user1', 'media-2'));
    vi.advanceTimersByTime(5_000);

    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback.mock.calls[0][0]).toHaveLength(1);
    expect(callback.mock.calls[1][0]).toHaveLength(1);
  });

  it('clearImageGroupBuffers resets all state', () => {
    const callback = vi.fn();
    onImageGroupComplete(callback);

    bufferImageMessage(makeImageMsg('user1', 'media-1'));
    clearImageGroupBuffers();

    // Advance time — callback should NOT fire (cleared)
    vi.advanceTimersByTime(10_000);
    expect(callback).not.toHaveBeenCalled();

    // Buffering should also not work (callback cleared)
    expect(bufferImageMessage(makeImageMsg('user1', 'media-2'))).toBe(false);
  });
});

// ── BatchUploadResult type checks ──────────────────────────────────────────

describe('BatchUploadResult type', () => {
  it('has the correct shape for successful results', () => {
    const result: BatchUploadResult = {
      originalPath: '/path/to/image.jpg',
      success: true,
      assetUrl: 'https://images.squarespace-cdn.com/content/123',
      assetId: 'asset-456',
      jobId: 'job-789',
    };

    expect(result.originalPath).toBe('/path/to/image.jpg');
    expect(result.success).toBe(true);
    expect(result.assetUrl).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  it('has the correct shape for failed results', () => {
    const result: BatchUploadResult = {
      originalPath: '/path/to/image.jpg',
      success: false,
      error: 'Upload failed: 413 Payload Too Large',
    };

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.assetUrl).toBeUndefined();
  });
});
