import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { listWaybackSnapshots, fetchWaybackContent } from '../wayback.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

describe('listWaybackSnapshots', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('parses CDX JSON response correctly (first row is headers)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [
        ['timestamp', 'statuscode'],
        ['20250115123456', '200'],
        ['20250220091011', '200'],
      ],
    });

    const result = await listWaybackSnapshots('https://example.com');

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      timestamp: '20250115123456',
      displayDate: '2025-01-15',
      url: 'https://web.archive.org/web/20250115123456/https://example.com',
    });
    expect(result[1]).toEqual({
      timestamp: '20250220091011',
      displayDate: '2025-02-20',
      url: 'https://web.archive.org/web/20250220091011/https://example.com',
    });
  });

  it('returns empty array on network error', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));

    const result = await listWaybackSnapshots('https://example.com');
    expect(result).toEqual([]);
  });

  it('returns empty array on timeout', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new DOMException('Aborted', 'AbortError'));

    const result = await listWaybackSnapshots('https://example.com');
    expect(result).toEqual([]);
  });

  it('respects limit parameter', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [['timestamp', 'statuscode']],
    });

    await listWaybackSnapshots('https://example.com', { limit: 5 });

    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain('limit=5');
  });

  it('handles empty CDX response (just headers)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [['timestamp', 'statuscode']],
    });

    const result = await listWaybackSnapshots('https://example.com');
    expect(result).toEqual([]);
  });

  it('correctly encodes page URL for CDX API', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [['timestamp', 'statuscode']],
    });

    await listWaybackSnapshots('https://example.com/my page');

    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain('url=https%3A%2F%2Fexample.com%2Fmy%20page');
  });
});

describe('fetchWaybackContent', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('extracts page title', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => '<html><head><title>My Page Title</title></head><body></body></html>',
    });

    const result = await fetchWaybackContent('https://example.com', '20250115');
    expect(result.pageTitle).toBe('My Page Title');
  });

  it('extracts sections from page-section divs', async () => {
    const html = `<html><head><title>Test</title></head><body>
      <div class="page-section first"><h1>Section 1</h1><p>Paragraph 1</p></div>
      <div class="page-section second"><h2>Section 2</h2><p>Paragraph 2</p></div>
    </body></html>`;

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => html,
    });

    const result = await fetchWaybackContent('https://example.com', '20250115');
    expect(result.sections).toHaveLength(2);
    expect(result.sections[0].headings).toEqual(['Section 1']);
    expect(result.sections[0].paragraphs).toEqual(['Paragraph 1']);
    expect(result.sections[1].headings).toEqual(['Section 2']);
    expect(result.sections[1].paragraphs).toEqual(['Paragraph 2']);
  });

  it('extracts headings, paragraphs, images, links from sections', async () => {
    const html = `<html><head><title>Test</title></head><body>
      <div class="page-section">
        <h1>Title</h1>
        <h2>Subtitle</h2>
        <p>Hello world</p>
        <img src="https://example.com/img.jpg" alt="Photo">
        <a href="/about">About Us</a>
      </div>
    </body></html>`;

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => html,
    });

    const result = await fetchWaybackContent('https://example.com', '20250115');
    const section = result.sections[0];
    expect(section.headings).toEqual(['Title', 'Subtitle']);
    expect(section.paragraphs).toEqual(['Hello world']);
    expect(section.images).toEqual([{ src: 'https://example.com/img.jpg', alt: 'Photo' }]);
    expect(section.links).toEqual([{ href: '/about', text: 'About Us' }]);
  });

  it('strips Wayback URL wrappers from image sources', async () => {
    const html = `<html><head><title>Test</title></head><body>
      <div class="page-section">
        <img src="https://web.archive.org/web/20250115im_/https://example.com/photo.jpg" alt="A">
        <img src="https://web.archive.org/web/20250115id_/https://example.com/pic.png" alt="B">
        <img src="https://web.archive.org/web/20250115/https://example.com/raw.gif" alt="C">
      </div>
    </body></html>`;

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => html,
    });

    const result = await fetchWaybackContent('https://example.com', '20250115');
    expect(result.sections[0].images).toEqual([
      { src: 'https://example.com/photo.jpg', alt: 'A' },
      { src: 'https://example.com/pic.png', alt: 'B' },
      { src: 'https://example.com/raw.gif', alt: 'C' },
    ]);
  });

  it('falls back to body extraction when no page-section divs found', async () => {
    const html = `<html><head><title>Test</title></head><body>
      <h1>Hello</h1>
      <p>World</p>
    </body></html>`;

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => html,
    });

    const result = await fetchWaybackContent('https://example.com', '20250115');
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].headings).toEqual(['Hello']);
    expect(result.sections[0].paragraphs).toEqual(['World']);
  });

  it('handles missing title gracefully', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => '<html><head></head><body><p>No title</p></body></html>',
    });

    const result = await fetchWaybackContent('https://example.com', '20250115');
    expect(result.pageTitle).toBe('');
  });

  it('strips HTML tags and decodes entities', async () => {
    const html = `<html><head><title>Test</title></head><body>
      <div class="page-section">
        <h1><span class="bold">Bold &amp; <em>Italic</em></span></h1>
        <p>A &lt;tag&gt; &amp; a &quot;quote&quot;</p>
      </div>
    </body></html>`;

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => html,
    });

    const result = await fetchWaybackContent('https://example.com', '20250115');
    expect(result.sections[0].headings).toEqual(['Bold & Italic']);
    expect(result.sections[0].paragraphs).toEqual(['A <tag> & a "quote"']);
  });

  it('includes correct metadata', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => '<html><head><title>Test</title></head><body></body></html>',
    });

    const result = await fetchWaybackContent('https://example.com', '20250115');
    expect(result.metadata).toEqual({
      timestamp: '20250115',
      originalUrl: 'https://example.com',
      waybackUrl: 'https://web.archive.org/web/20250115id_/https://example.com',
    });
  });
});
