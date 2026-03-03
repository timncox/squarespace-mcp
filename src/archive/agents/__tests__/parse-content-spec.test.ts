import { describe, it, expect } from 'vitest';
import { parseContentSpec } from '../content-strategist-agent.js';

// ── Tests for parseContentSpec ──────────────────────────────────────────────

describe('parseContentSpec', () => {
  // ── Gallery display fields ──────────────────────────────────────────────

  describe('gallery display fields', () => {
    it('extracts galleryColumns when input is a number', () => {
      const result = parseContentSpec({ galleryColumns: 3 });
      expect(result.galleryColumns).toBe(3);
    });

    it('returns undefined for galleryColumns when input is a string', () => {
      const result = parseContentSpec({ galleryColumns: '3' });
      expect(result.galleryColumns).toBeUndefined();
    });

    it('extracts galleryAspectRatio when input is a string', () => {
      const result = parseContentSpec({ galleryAspectRatio: '3:2' });
      expect(result.galleryAspectRatio).toBe('3:2');
    });

    it('returns undefined for galleryAspectRatio when input is a number', () => {
      const result = parseContentSpec({ galleryAspectRatio: 1.5 });
      expect(result.galleryAspectRatio).toBeUndefined();
    });

    it('extracts galleryDesign when input is a string', () => {
      const result = parseContentSpec({ galleryDesign: 'grid' });
      expect(result.galleryDesign).toBe('grid');
    });

    it('extracts galleryPadding when input is a number', () => {
      const result = parseContentSpec({ galleryPadding: 10 });
      expect(result.galleryPadding).toBe(10);
    });

    it('extracts galleryLightbox true as boolean true', () => {
      const result = parseContentSpec({ galleryLightbox: true });
      expect(result.galleryLightbox).toBe(true);
    });

    it('returns undefined for galleryLightbox when input is string "true"', () => {
      const result = parseContentSpec({ galleryLightbox: 'true' });
      expect(result.galleryLightbox).toBeUndefined();
    });

    it('extracts galleryAutoCrop false as boolean false', () => {
      const result = parseContentSpec({ galleryAutoCrop: false });
      expect(result.galleryAutoCrop).toBe(false);
    });
  });

  // ── Section reorder fields ──────────────────────────────────────────────

  describe('section reorder fields', () => {
    it('extracts sectionDirection "up"', () => {
      const result = parseContentSpec({ sectionDirection: 'up' });
      expect(result.sectionDirection).toBe('up');
    });

    it('extracts sectionDirection "down"', () => {
      const result = parseContentSpec({ sectionDirection: 'down' });
      expect(result.sectionDirection).toBe('down');
    });

    it('extracts sectionOrder when input is an array of numbers', () => {
      const result = parseContentSpec({ sectionOrder: [0, 2, 1] });
      expect(result.sectionOrder).toEqual([0, 2, 1]);
    });

    it('returns undefined for sectionOrder when input is not an array', () => {
      const result = parseContentSpec({ sectionOrder: 'reverse' });
      expect(result.sectionOrder).toBeUndefined();
    });
  });

  // ── Block layout fields ─────────────────────────────────────────────────

  describe('block layout fields', () => {
    it('extracts blockDirection "left"', () => {
      const result = parseContentSpec({ blockDirection: 'left' });
      expect(result.blockDirection).toBe('left');
    });

    it('extracts gridSteps when input is a number', () => {
      const result = parseContentSpec({ gridSteps: 3 });
      expect(result.gridSteps).toBe(3);
    });

    it('returns undefined for gridSteps when input is a string', () => {
      const result = parseContentSpec({ gridSteps: '3' });
      expect(result.gridSteps).toBeUndefined();
    });

    it('extracts blockWidth "larger"', () => {
      const result = parseContentSpec({ blockWidth: 'larger' });
      expect(result.blockWidth).toBe('larger');
    });

    it('extracts blockHeight "taller"', () => {
      const result = parseContentSpec({ blockHeight: 'taller' });
      expect(result.blockHeight).toBe('taller');
    });
  });

  // ── Code injection + CSS fields ─────────────────────────────────────────

  describe('code injection and CSS fields', () => {
    it('extracts codeInjectionHeader when input is a string', () => {
      const result = parseContentSpec({ codeInjectionHeader: '<script>ga("send")</script>' });
      expect(result.codeInjectionHeader).toBe('<script>ga("send")</script>');
    });

    it('extracts codeInjectionFooter when input is a string', () => {
      const result = parseContentSpec({ codeInjectionFooter: '<script>footer()</script>' });
      expect(result.codeInjectionFooter).toBe('<script>footer()</script>');
    });

    it('extracts cssCode when input is a string', () => {
      const result = parseContentSpec({ cssCode: 'body { color: red; }' });
      expect(result.cssCode).toBe('body { color: red; }');
    });
  });

  // ── Blog fields ─────────────────────────────────────────────────────────

  describe('blog fields', () => {
    it('extracts blogCollectionId when input is a string', () => {
      const result = parseContentSpec({ blogCollectionId: 'abc123' });
      expect(result.blogCollectionId).toBe('abc123');
    });

    it('extracts blogPostId when input is a string', () => {
      const result = parseContentSpec({ blogPostId: 'post456' });
      expect(result.blogPostId).toBe('post456');
    });

    it('extracts blogTitle and blogBody together', () => {
      const result = parseContentSpec({
        blogTitle: 'My First Post',
        blogBody: '<p>Hello world</p>',
      });
      expect(result.blogTitle).toBe('My First Post');
      expect(result.blogBody).toBe('<p>Hello world</p>');
    });

    it('extracts blogTags when input is an array', () => {
      const result = parseContentSpec({ blogTags: ['tag1', 'tag2'] });
      expect(result.blogTags).toEqual(['tag1', 'tag2']);
    });

    it('returns undefined for blogTags when input is not an array', () => {
      const result = parseContentSpec({ blogTags: 'tag1,tag2' });
      expect(result.blogTags).toBeUndefined();
    });

    it('extracts blogDraft true', () => {
      const result = parseContentSpec({ blogDraft: true });
      expect(result.blogDraft).toBe(true);
    });

    it('extracts blogDraft false', () => {
      const result = parseContentSpec({ blogDraft: false });
      expect(result.blogDraft).toBe(false);
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('returns empty object when input is undefined', () => {
      const result = parseContentSpec(undefined);
      expect(result).toEqual({});
    });

    it('returns object with all fields undefined when input is empty object', () => {
      const result = parseContentSpec({});
      expect(result.heading).toBeUndefined();
      expect(result.bodyText).toBeUndefined();
      expect(result.button).toBeUndefined();
      expect(result.galleryColumns).toBeUndefined();
      expect(result.sectionDirection).toBeUndefined();
      expect(result.blockDirection).toBeUndefined();
      expect(result.codeInjectionHeader).toBeUndefined();
      expect(result.cssCode).toBeUndefined();
      expect(result.blogCollectionId).toBeUndefined();
      expect(result.blogTags).toBeUndefined();
      expect(result.blogDraft).toBeUndefined();
    });
  });

  // ── Existing fields regression ──────────────────────────────────────────

  describe('existing fields regression', () => {
    it('still extracts heading, bodyText, and button correctly', () => {
      const result = parseContentSpec({
        heading: 'Welcome',
        bodyText: 'Hello world',
        button: { label: 'Click Me', url: '/about' },
      });
      expect(result.heading).toBe('Welcome');
      expect(result.bodyText).toBe('Hello world');
      expect(result.button).toEqual({ label: 'Click Me', url: '/about' });
    });

    it('extracts templateIndex as number, rejects string', () => {
      const numResult = parseContentSpec({ templateIndex: 2 });
      expect(numResult.templateIndex).toBe(2);

      const strResult = parseContentSpec({ templateIndex: '2' });
      expect(strResult.templateIndex).toBeUndefined();
    });
  });

  // ── Duplicate/Swap fields ──────────────────────────────────────────────

  describe('duplicate and swap fields', () => {
    it('extracts duplicateBlockSearchText', () => {
      const result = parseContentSpec({ duplicateBlockSearchText: 'About Us' });
      expect(result.duplicateBlockSearchText).toBe('About Us');
    });

    it('rejects non-string duplicateBlockSearchText', () => {
      const result = parseContentSpec({ duplicateBlockSearchText: 42 });
      expect(result.duplicateBlockSearchText).toBeUndefined();
    });

    it('extracts duplicateSectionSearch as string', () => {
      const result = parseContentSpec({ duplicateSectionSearch: 'Hero Section' });
      expect(result.duplicateSectionSearch).toBe('Hero Section');
    });

    it('extracts duplicateSectionSearch as number (index)', () => {
      const result = parseContentSpec({ duplicateSectionSearch: 0 });
      expect(result.duplicateSectionSearch).toBe(0);
    });

    it('extracts duplicateSectionSearch as number > 0', () => {
      const result = parseContentSpec({ duplicateSectionSearch: 3 });
      expect(result.duplicateSectionSearch).toBe(3);
    });

    it('rejects non-string/non-number duplicateSectionSearch', () => {
      const result = parseContentSpec({ duplicateSectionSearch: true });
      expect(result.duplicateSectionSearch).toBeUndefined();
    });

    it('extracts swapBlock1SearchText', () => {
      const result = parseContentSpec({ swapBlock1SearchText: 'About Us' });
      expect(result.swapBlock1SearchText).toBe('About Us');
    });

    it('extracts swapBlock2SearchText', () => {
      const result = parseContentSpec({ swapBlock2SearchText: 'Our Mission' });
      expect(result.swapBlock2SearchText).toBe('Our Mission');
    });

    it('rejects non-string swap search texts', () => {
      const r1 = parseContentSpec({ swapBlock1SearchText: 123 });
      expect(r1.swapBlock1SearchText).toBeUndefined();

      const r2 = parseContentSpec({ swapBlock2SearchText: null });
      expect(r2.swapBlock2SearchText).toBeUndefined();
    });

    it('extracts all duplicate/swap fields together', () => {
      const result = parseContentSpec({
        duplicateBlockSearchText: 'Block A',
        duplicateSectionSearch: 1,
        swapBlock1SearchText: 'Block B',
        swapBlock2SearchText: 'Block C',
      });
      expect(result.duplicateBlockSearchText).toBe('Block A');
      expect(result.duplicateSectionSearch).toBe(1);
      expect(result.swapBlock1SearchText).toBe('Block B');
      expect(result.swapBlock2SearchText).toBe('Block C');
    });
  });
});
