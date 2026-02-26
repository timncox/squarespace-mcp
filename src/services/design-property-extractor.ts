/**
 * Design Property Extractor — pure functions for reading design properties
 * from Squarespace API data (HTML, grid layout, section metadata).
 *
 * These functions extract existing styling information so agents can match
 * the site's design when creating new content.
 *
 * All functions are pure (no API calls, no side effects).
 */

import type { TextStyles, GridSpan, ExtractedLink, SectionDesignProperties } from '../agents/types.js';

// ─── CSS Inline Parser ──────────────────────────────────────────────────────

/**
 * Parse a CSS inline style string into key-value pairs.
 * e.g. "text-align:center;color:red" → { "text-align": "center", "color": "red" }
 */
export function parseCssInline(cssText: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cssText) return result;

  const declarations = cssText.split(';');
  for (const decl of declarations) {
    const trimmed = decl.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx < 1) continue;
    const prop = trimmed.substring(0, colonIdx).trim().toLowerCase();
    const value = trimmed.substring(colonIdx + 1).trim();
    if (prop && value) {
      result[prop] = value;
    }
  }
  return result;
}

// ─── Text Style Extractor ───────────────────────────────────────────────────

/**
 * Extract text styles from an HTML string.
 *
 * Parses the first block-level tag for heading level (h1-h4, p),
 * the first style="" attribute for CSS properties, and detects
 * <strong>/<b> for bold and <em>/<i> for italic.
 *
 * Skips `white-space:pre-wrap` (Squarespace default, not meaningful).
 */
export function extractTextStyles(html: string): TextStyles {
  if (!html || !html.trim()) return {};

  const styles: TextStyles = {};

  // Extract heading tag from first block-level element
  const tagMatch = html.match(/<(h[1-4]|p)[\s>]/i);
  if (tagMatch) {
    styles.headingTag = tagMatch[1].toLowerCase() as TextStyles['headingTag'];
  }

  // Extract inline styles from first style="" attribute
  const styleMatch = html.match(/style\s*=\s*"([^"]*)"/i);
  if (styleMatch) {
    const css = parseCssInline(styleMatch[1]);

    // Map CSS properties to TextStyles fields, skip white-space:pre-wrap
    if (css['text-align']) {
      const align = css['text-align'] as TextStyles['alignment'];
      if (align === 'left' || align === 'center' || align === 'right') {
        styles.alignment = align;
      }
    }
    if (css['color']) styles.color = css['color'];
    if (css['font-size']) styles.fontSize = css['font-size'];
    if (css['font-family']) styles.fontFamily = css['font-family'];
    if (css['font-weight']) styles.fontWeight = css['font-weight'];
    if (css['letter-spacing']) styles.letterSpacing = css['letter-spacing'];
    if (css['line-height']) styles.lineHeight = css['line-height'];
    if (css['text-transform']) styles.textTransform = css['text-transform'];
    // Skip white-space:pre-wrap — it's the Squarespace default
  }

  // Detect bold (<strong> or <b>)
  if (/<(?:strong|b)[\s>]/i.test(html)) {
    styles.bold = true;
  }

  // Detect italic (<em> or <i>)
  if (/<(?:em|i)[\s>]/i.test(html)) {
    styles.italic = true;
  }

  return styles;
}

// ─── Grid Span Extractor ────────────────────────────────────────────────────

/**
 * Extract grid span (columns/rows) from a gridContent layout object.
 *
 * Reads `layout.desktop.start/end` coordinates and calculates the
 * column and row span. Returns undefined if no layout data is available.
 */
export function extractGridSpan(gridContent: unknown): GridSpan | undefined {
  const gc = gridContent as {
    layout?: {
      desktop?: {
        start?: { x?: number; y?: number };
        end?: { x?: number; y?: number };
      };
    };
  };

  const desktop = gc?.layout?.desktop;
  if (!desktop?.start || !desktop?.end) return undefined;

  const startX = desktop.start.x ?? 0;
  const startY = desktop.start.y ?? 0;
  const endX = desktop.end.x ?? 0;
  const endY = desktop.end.y ?? 0;

  if (endX <= startX && endY <= startY) return undefined;

  return {
    columns: endX - startX,
    rows: endY - startY,
    startX,
    endX,
    startY,
    endY,
  };
}

// ─── Link Extractor ─────────────────────────────────────────────────────────

/**
 * Extract links from an HTML string.
 *
 * Finds all <a> tags, extracts href, target, and text content
 * (stripping inner tags from the link text).
 */
export function extractLinks(html: string): ExtractedLink[] {
  if (!html) return [];

  const links: ExtractedLink[] = [];
  // Match <a ...>...</a> — non-greedy inner content
  const linkRegex = /<a\s+([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(html)) !== null) {
    const attrs = match[1];
    const innerHtml = match[2];

    // Extract href
    const hrefMatch = attrs.match(/href\s*=\s*"([^"]*)"/i);
    if (!hrefMatch) continue;

    // Extract target (optional)
    const targetMatch = attrs.match(/target\s*=\s*"([^"]*)"/i);

    // Strip inner tags to get plain text
    const text = innerHtml.replace(/<[^>]+>/g, '').trim();

    const link: ExtractedLink = {
      text,
      href: hrefMatch[1],
    };

    if (targetMatch) {
      link.target = targetMatch[1];
    }

    links.push(link);
  }

  return links;
}

// ─── Section Design Extractor ───────────────────────────────────────────────

/**
 * Extract section-level design properties from a Squarespace section object.
 *
 * Probes multiple paths for theme (sectionTheme, colorTheme, theme,
 * designPreset.theme), background color/image, height, width, padding,
 * and block spacing. Returns undefined if no design properties found.
 */
export function extractSectionDesign(section: unknown): SectionDesignProperties | undefined {
  const sec = section as Record<string, unknown>;
  if (!sec || typeof sec !== 'object') return undefined;

  const design: SectionDesignProperties = {};
  let hasAny = false;

  // Theme — probe multiple possible paths
  const theme =
    (sec.sectionTheme as string) ??
    (sec.colorTheme as string) ??
    (sec.theme as string) ??
    ((sec.designPreset as Record<string, unknown>)?.theme as string) ??
    undefined;
  if (theme) {
    design.theme = theme;
    hasAny = true;
  }

  // Background color
  if (sec.backgroundColor) {
    design.backgroundColor = sec.backgroundColor as string;
    hasAny = true;
  }

  // Background image (just flag presence)
  if (sec.backgroundImage) {
    design.hasBackgroundImage = true;
    hasAny = true;
  }

  // Section height
  if (sec.sectionHeight) {
    design.sectionHeight = sec.sectionHeight as string;
    hasAny = true;
  }

  // Content width
  if (sec.contentWidth) {
    design.contentWidth = sec.contentWidth as string;
    hasAny = true;
  }

  // Vertical alignment
  if (sec.verticalAlignment) {
    design.verticalAlignment = sec.verticalAlignment as string;
    hasAny = true;
  }

  // Section padding
  if (sec.sectionPadding) {
    design.sectionPadding = sec.sectionPadding as string;
    hasAny = true;
  }

  // Block spacing
  if (sec.blockSpacing) {
    design.blockSpacing = sec.blockSpacing as string;
    hasAny = true;
  }

  return hasAny ? design : undefined;
}
