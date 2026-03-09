import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContentSaveClient } from '../content-save.js';

// ── Mock session file ─────────────────────────────────────────────────────

const MOCK_SESSION = {
  cookies: [
    { name: 'SS_SESSION_ID', value: 'sess123', domain: '.squarespace.com', path: '/' },
    { name: 'crumb', value: 'crumb-token-abc', domain: '.test-site.squarespace.com', path: '/' },
  ],
};

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => JSON.stringify(MOCK_SESSION)),
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() - 3600_000 })), // 1 hour old
}));

// ── Tests ─────────────────────────────────────────────────────────────────

describe('ContentSaveClient — patchCustomCSS', () => {
  let client: ContentSaveClient;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // Helper: mock getCustomCSS response (GET), then saveCustomCSS response (POST)
  function mockCssRoundtrip(currentCss: string) {
    // getCustomCSS — GET request
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ customCss: currentCss }), { status: 200 }),
    );
    // saveCustomCSS — POST request
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
  }

  // ── Add operation ──────────────────────────────────────────────────────

  describe('add operation', () => {
    it('should append CSS rule to existing CSS', async () => {
      mockCssRoundtrip('body { margin: 0; }');

      const result = await client.patchCustomCSS([
        { action: 'add', css: '.header { color: red; }' },
      ]);

      expect(result.success).toBe(true);
      expect(result.appliedOps).toBe(1);

      // Verify what was saved
      const savedCss = JSON.parse(fetchSpy.mock.calls[1][1]?.body as string).customCss;
      expect(savedCss).toContain('body { margin: 0; }');
      expect(savedCss).toContain('.header { color: red; }');
    });

    it('should handle adding to empty CSS', async () => {
      mockCssRoundtrip('');

      const result = await client.patchCustomCSS([
        { action: 'add', css: '.new { display: flex; }' },
      ]);

      expect(result.success).toBe(true);
      const savedCss = JSON.parse(fetchSpy.mock.calls[1][1]?.body as string).customCss;
      expect(savedCss).toBe('.new { display: flex; }');
    });

    it('should return error when css field is missing', async () => {
      mockCssRoundtrip('body {}');

      const result = await client.patchCustomCSS([
        { action: 'add' },
      ]);

      expect(result.success).toBe(false);
      expect(result.error).toContain('requires "css" field');
    });
  });

  // ── Remove operation ───────────────────────────────────────────────────

  describe('remove operation', () => {
    it('should remove a rule by selector', async () => {
      mockCssRoundtrip('body { margin: 0; }\n.remove-me { color: red; }\n.keep { display: flex; }');

      const result = await client.patchCustomCSS([
        { action: 'remove', selector: '.remove-me' },
      ]);

      expect(result.success).toBe(true);
      expect(result.appliedOps).toBe(1);

      const savedCss = JSON.parse(fetchSpy.mock.calls[1][1]?.body as string).customCss;
      expect(savedCss).not.toContain('.remove-me');
      expect(savedCss).toContain('body { margin: 0; }');
      expect(savedCss).toContain('.keep { display: flex; }');
    });

    it('should return error when selector not found', async () => {
      mockCssRoundtrip('body { margin: 0; }');

      const result = await client.patchCustomCSS([
        { action: 'remove', selector: '.nonexistent' },
      ]);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Selector not found: .nonexistent');
    });

    it('should return error when selector field is missing', async () => {
      mockCssRoundtrip('body {}');

      const result = await client.patchCustomCSS([
        { action: 'remove' },
      ]);

      expect(result.success).toBe(false);
      expect(result.error).toContain('requires "selector" field');
    });
  });

  // ── Replace operation ──────────────────────────────────────────────────

  describe('replace operation', () => {
    it('should replace a rule by selector', async () => {
      mockCssRoundtrip('body { margin: 0; }\n.target { color: red; }\n.other { display: flex; }');

      const result = await client.patchCustomCSS([
        { action: 'replace', selector: '.target', css: '.target { color: blue; font-size: 16px; }' },
      ]);

      expect(result.success).toBe(true);
      expect(result.appliedOps).toBe(1);

      const savedCss = JSON.parse(fetchSpy.mock.calls[1][1]?.body as string).customCss;
      expect(savedCss).toContain('.target { color: blue; font-size: 16px; }');
      expect(savedCss).not.toContain('color: red');
      expect(savedCss).toContain('body { margin: 0; }');
      expect(savedCss).toContain('.other { display: flex; }');
    });

    it('should return error when selector not found', async () => {
      mockCssRoundtrip('body { margin: 0; }');

      const result = await client.patchCustomCSS([
        { action: 'replace', selector: '.nonexistent', css: '.nonexistent { color: red; }' },
      ]);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Selector not found: .nonexistent');
    });

    it('should return error when selector field is missing', async () => {
      mockCssRoundtrip('body {}');

      const result = await client.patchCustomCSS([
        { action: 'replace', css: '.x { color: red; }' },
      ]);

      expect(result.success).toBe(false);
      expect(result.error).toContain('requires "selector" field');
    });

    it('should return error when css field is missing', async () => {
      mockCssRoundtrip('body { margin: 0; }');

      const result = await client.patchCustomCSS([
        { action: 'replace', selector: 'body' },
      ]);

      expect(result.success).toBe(false);
      expect(result.error).toContain('requires "css" field');
    });
  });

  // ── Multiple operations ────────────────────────────────────────────────

  describe('multiple operations', () => {
    it('should apply operations in order', async () => {
      mockCssRoundtrip('body { margin: 0; }\n.old { color: red; }');

      const result = await client.patchCustomCSS([
        { action: 'remove', selector: '.old' },
        { action: 'add', css: '.new { display: flex; }' },
        { action: 'replace', selector: 'body', css: 'body { margin: 10px; }' },
      ]);

      expect(result.success).toBe(true);
      expect(result.appliedOps).toBe(3);

      const savedCss = JSON.parse(fetchSpy.mock.calls[1][1]?.body as string).customCss;
      expect(savedCss).not.toContain('.old');
      expect(savedCss).toContain('.new { display: flex; }');
      expect(savedCss).toContain('body { margin: 10px; }');
      expect(savedCss).not.toContain('margin: 0');
    });
  });

  // ── Nested braces (media queries) ──────────────────────────────────────

  describe('nested braces', () => {
    it('should handle media queries with nested rules', async () => {
      const css = [
        'body { margin: 0; }',
        '@media (max-width: 768px) {',
        '  .container { width: 100%; }',
        '  .sidebar { display: none; }',
        '}',
        '.footer { padding: 20px; }',
      ].join('\n');

      mockCssRoundtrip(css);

      const result = await client.patchCustomCSS([
        { action: 'remove', selector: '@media (max-width: 768px)' },
      ]);

      expect(result.success).toBe(true);
      const savedCss = JSON.parse(fetchSpy.mock.calls[1][1]?.body as string).customCss;
      expect(savedCss).toContain('body { margin: 0; }');
      expect(savedCss).not.toContain('@media');
      expect(savedCss).not.toContain('.container');
      expect(savedCss).not.toContain('.sidebar');
      expect(savedCss).toContain('.footer { padding: 20px; }');
    });

    it('should replace a media query block', async () => {
      const css = [
        'body { margin: 0; }',
        '@media (max-width: 768px) {',
        '  .container { width: 100%; }',
        '}',
      ].join('\n');

      mockCssRoundtrip(css);

      const newMedia = '@media (max-width: 1024px) {\n  .container { width: 80%; }\n}';
      const result = await client.patchCustomCSS([
        { action: 'replace', selector: '@media (max-width: 768px)', css: newMedia },
      ]);

      expect(result.success).toBe(true);
      const savedCss = JSON.parse(fetchSpy.mock.calls[1][1]?.body as string).customCss;
      expect(savedCss).toContain('1024px');
      expect(savedCss).toContain('width: 80%');
      expect(savedCss).not.toContain('768px');
    });
  });

  // ── Error handling ─────────────────────────────────────────────────────

  describe('error handling', () => {
    it('should return error when getCustomCSS fails', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('Unauthorized', { status: 401 }),
      );

      const result = await client.patchCustomCSS([
        { action: 'add', css: 'body {}' },
      ]);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to read current CSS');
    });

    it('should return error when saveCustomCSS fails', async () => {
      // GET succeeds
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ customCss: 'body {}' }), { status: 200 }),
      );
      // POST fails
      fetchSpy.mockResolvedValueOnce(
        new Response('Server Error', { status: 500, statusText: 'Internal Server Error' }),
      );

      const result = await client.patchCustomCSS([
        { action: 'add', css: '.new { color: red; }' },
      ]);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to save CSS');
    });

    it('should return error for empty operations array', async () => {
      const result = await client.patchCustomCSS([]);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No operations provided');
    });

    it('should handle network errors gracefully', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Network timeout'));

      const result = await client.patchCustomCSS([
        { action: 'add', css: 'body {}' },
      ]);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network timeout');
    });
  });

  // ── Complex selectors ──────────────────────────────────────────────────

  describe('complex selectors', () => {
    it('should handle class selectors with dots', async () => {
      mockCssRoundtrip('.my-class { color: red; }\n.other { display: flex; }');

      const result = await client.patchCustomCSS([
        { action: 'remove', selector: '.my-class' },
      ]);

      expect(result.success).toBe(true);
      const savedCss = JSON.parse(fetchSpy.mock.calls[1][1]?.body as string).customCss;
      expect(savedCss).not.toContain('.my-class');
      expect(savedCss).toContain('.other');
    });

    it('should handle ID selectors', async () => {
      mockCssRoundtrip('#header { background: blue; }\n.footer { padding: 10px; }');

      const result = await client.patchCustomCSS([
        { action: 'replace', selector: '#header', css: '#header { background: green; }' },
      ]);

      expect(result.success).toBe(true);
      const savedCss = JSON.parse(fetchSpy.mock.calls[1][1]?.body as string).customCss;
      expect(savedCss).toContain('background: green');
      expect(savedCss).not.toContain('background: blue');
    });

    it('should handle element selectors', async () => {
      mockCssRoundtrip('h1 { font-size: 2em; }\np { line-height: 1.5; }');

      const result = await client.patchCustomCSS([
        { action: 'replace', selector: 'h1', css: 'h1 { font-size: 3em; }' },
      ]);

      expect(result.success).toBe(true);
      const savedCss = JSON.parse(fetchSpy.mock.calls[1][1]?.body as string).customCss;
      expect(savedCss).toContain('font-size: 3em');
      expect(savedCss).toContain('p { line-height: 1.5; }');
    });
  });
});
