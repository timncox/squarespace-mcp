import { describe, it, expect } from 'vitest';
import {
  parseCssInline,
  extractTextStyles,
  extractGridSpan,
  extractLinks,
  extractSectionDesign,
} from '../design-property-extractor.js';

// ── parseCssInline ──────────────────────────────────────────────────────────

describe('parseCssInline', () => {
  it('parses a single property', () => {
    expect(parseCssInline('text-align:center')).toEqual({ 'text-align': 'center' });
  });

  it('parses multiple properties', () => {
    expect(parseCssInline('text-align:center;color:red;font-size:18px')).toEqual({
      'text-align': 'center',
      'color': 'red',
      'font-size': '18px',
    });
  });

  it('returns empty object for empty string', () => {
    expect(parseCssInline('')).toEqual({});
  });

  it('handles trailing semicolons and whitespace', () => {
    expect(parseCssInline('  color: blue ; font-size: 14px ; ')).toEqual({
      'color': 'blue',
      'font-size': '14px',
    });
  });
});

// ── extractTextStyles ───────────────────────────────────────────────────────

describe('extractTextStyles', () => {
  it('returns empty object for empty string', () => {
    expect(extractTextStyles('')).toEqual({});
  });

  it('extracts heading tag and alignment', () => {
    const result = extractTextStyles('<h2 style="text-align:center;">Title</h2>');
    expect(result).toEqual({ headingTag: 'h2', alignment: 'center' });
  });

  it('extracts alignment and color, skipping white-space:pre-wrap', () => {
    const result = extractTextStyles('<p style="white-space:pre-wrap;text-align:center;color:#fff;">text</p>');
    expect(result).toEqual({ headingTag: 'p', alignment: 'center', color: '#fff' });
  });

  it('extracts fontSize and fontFamily', () => {
    const result = extractTextStyles('<p style="font-size:18px;font-family:Georgia;">text</p>');
    expect(result.headingTag).toBe('p');
    expect(result.fontSize).toBe('18px');
    expect(result.fontFamily).toBe('Georgia');
  });

  it('detects bold from <strong> tag', () => {
    const result = extractTextStyles('<p><strong>Bold text</strong></p>');
    expect(result).toEqual({ headingTag: 'p', bold: true });
  });

  it('detects italic from <em> tag', () => {
    const result = extractTextStyles('<p><em>Italic text</em></p>');
    expect(result).toEqual({ headingTag: 'p', italic: true });
  });

  it('extracts textTransform and letterSpacing', () => {
    const result = extractTextStyles('<h1 style="text-transform:uppercase;letter-spacing:2px;">HEADING</h1>');
    expect(result.headingTag).toBe('h1');
    expect(result.textTransform).toBe('uppercase');
    expect(result.letterSpacing).toBe('2px');
  });

  it('extracts from first block-level tag when multiple are present', () => {
    const result = extractTextStyles('<h2 style="text-align:center;">Title</h2><p style="color:red;">Body</p>');
    // Should extract from the first tag
    expect(result.headingTag).toBe('h2');
    expect(result.alignment).toBe('center');
    // Should not extract color from the second paragraph
    expect(result.color).toBeUndefined();
  });

  it('only returns headingTag when white-space:pre-wrap is the only style', () => {
    const result = extractTextStyles('<p style="white-space:pre-wrap;">plain</p>');
    expect(result).toEqual({ headingTag: 'p' });
  });

  it('detects bold from <b> tag', () => {
    const result = extractTextStyles('<p><b>Bold text</b></p>');
    expect(result.bold).toBe(true);
  });

  it('detects italic from <i> tag', () => {
    const result = extractTextStyles('<p><i>Italic text</i></p>');
    expect(result.italic).toBe(true);
  });
});

// ── extractGridSpan ─────────────────────────────────────────────────────────

describe('extractGridSpan', () => {
  it('extracts full width block', () => {
    const gc = {
      layout: {
        desktop: { start: { x: 1, y: 0 }, end: { x: 25, y: 3 } },
      },
    };
    const result = extractGridSpan(gc);
    expect(result).toEqual({
      columns: 24,
      rows: 3,
      startX: 1,
      endX: 25,
      startY: 0,
      endY: 3,
    });
  });

  it('extracts half width block', () => {
    const gc = {
      layout: {
        desktop: { start: { x: 1, y: 0 }, end: { x: 13, y: 4 } },
      },
    };
    const result = extractGridSpan(gc);
    expect(result!.columns).toBe(12);
    expect(result!.rows).toBe(4);
  });

  it('returns undefined for missing layout', () => {
    expect(extractGridSpan({})).toBeUndefined();
    expect(extractGridSpan({ content: {} })).toBeUndefined();
  });

  it('returns undefined for missing desktop', () => {
    expect(extractGridSpan({ layout: {} })).toBeUndefined();
    expect(extractGridSpan({ layout: { mobile: { start: { x: 1, y: 0 }, end: { x: 12, y: 4 } } } })).toBeUndefined();
  });

  it('returns undefined for null/undefined input', () => {
    expect(extractGridSpan(null)).toBeUndefined();
    expect(extractGridSpan(undefined)).toBeUndefined();
  });
});

// ── extractLinks ────────────────────────────────────────────────────────────

describe('extractLinks', () => {
  it('extracts a single link', () => {
    const result = extractLinks('<a href="https://example.com">Click</a>');
    expect(result).toEqual([{ text: 'Click', href: 'https://example.com' }]);
  });

  it('extracts mailto link', () => {
    const result = extractLinks('<a href="mailto:x@y.com">Email</a>');
    expect(result).toEqual([{ text: 'Email', href: 'mailto:x@y.com' }]);
  });

  it('extracts multiple links', () => {
    const html = '<p><a href="/about">About</a> and <a href="/contact">Contact</a></p>';
    const result = extractLinks(html);
    expect(result).toHaveLength(2);
    expect(result[0].href).toBe('/about');
    expect(result[1].href).toBe('/contact');
  });

  it('strips inner tags from link text', () => {
    const result = extractLinks('<a href="/page" target="_blank"><strong>Bold Link</strong></a>');
    expect(result).toEqual([{ text: 'Bold Link', href: '/page', target: '_blank' }]);
  });

  it('returns empty array when no links', () => {
    expect(extractLinks('<p>No links here</p>')).toEqual([]);
    expect(extractLinks('')).toEqual([]);
  });

  it('extracts target attribute', () => {
    const result = extractLinks('<a href="https://ext.com" target="_blank">External</a>');
    expect(result[0].target).toBe('_blank');
  });

  it('omits target when not present', () => {
    const result = extractLinks('<a href="/internal">Internal</a>');
    expect(result[0].target).toBeUndefined();
  });
});

// ── extractSectionDesign ────────────────────────────────────────────────────

describe('extractSectionDesign', () => {
  it('returns undefined for empty section', () => {
    expect(extractSectionDesign({})).toBeUndefined();
  });

  it('returns undefined for null/undefined', () => {
    expect(extractSectionDesign(null)).toBeUndefined();
    expect(extractSectionDesign(undefined)).toBeUndefined();
  });

  it('extracts sectionTheme', () => {
    expect(extractSectionDesign({ sectionTheme: 'Dark' })).toEqual({ theme: 'Dark' });
  });

  it('extracts colorTheme as fallback', () => {
    expect(extractSectionDesign({ colorTheme: 'Lightest' })).toEqual({ theme: 'Lightest' });
  });

  it('extracts theme from designPreset.theme', () => {
    expect(extractSectionDesign({ designPreset: { theme: 'Bold' } })).toEqual({ theme: 'Bold' });
  });

  it('prefers sectionTheme over colorTheme', () => {
    const result = extractSectionDesign({ sectionTheme: 'Dark', colorTheme: 'Lightest' });
    expect(result!.theme).toBe('Dark');
  });

  it('extracts backgroundColor', () => {
    expect(extractSectionDesign({ backgroundColor: '#000' })).toEqual({ backgroundColor: '#000' });
  });

  it('detects backgroundImage presence', () => {
    expect(extractSectionDesign({ backgroundImage: 'img.jpg' })).toEqual({ hasBackgroundImage: true });
  });

  it('extracts multiple properties together', () => {
    const result = extractSectionDesign({
      sectionTheme: 'Dark',
      backgroundColor: '#1a1a1a',
      sectionHeight: 'large',
      contentWidth: 'inset',
      sectionPadding: 'medium',
      blockSpacing: 'small',
    });
    expect(result).toEqual({
      theme: 'Dark',
      backgroundColor: '#1a1a1a',
      sectionHeight: 'large',
      contentWidth: 'inset',
      sectionPadding: 'medium',
      blockSpacing: 'small',
    });
  });

  it('extracts sectionHeight and contentWidth', () => {
    const result = extractSectionDesign({ sectionHeight: 'large', contentWidth: 'inset' });
    expect(result!.sectionHeight).toBe('large');
    expect(result!.contentWidth).toBe('inset');
  });

  it('extracts verticalAlignment', () => {
    const result = extractSectionDesign({ verticalAlignment: 'middle' });
    expect(result!.verticalAlignment).toBe('middle');
  });
});
