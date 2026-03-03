import { describe, it, expect } from 'vitest';
import { summarizePageSections } from '../coordinator.js';
import type { PageSection } from '../../services/content-save.js';
import type { PageStructure } from '../types.js';

// ── Helper: build a minimal PageSection ─────────────────────────────────────

function makeSection(overrides: Partial<PageSection> = {}): PageSection {
  return {
    id: 'section-001',
    sectionName: 'Test Section',
    fluidEngineContext: {
      gridContents: [],
    },
    ...overrides,
  };
}

function makeTextBlock(source: string, id = 'block-001') {
  return {
    layout: {
      desktop: { start: { x: 1, y: 1 }, end: { x: 24, y: 4 } },
      mobile: { start: { x: 1, y: 1 }, end: { x: 12, y: 4 } },
    },
    content: {
      value: {
        id,
        type: 2,
        value: {
          engine: 'wysiwyg',
          source,
          html: source,
        },
      },
    },
  };
}

function makeImageBlock(title: string, altText?: string, id = 'img-001') {
  return {
    layout: {
      desktop: { start: { x: 1, y: 1 }, end: { x: 12, y: 8 } },
      mobile: { start: { x: 1, y: 1 }, end: { x: 12, y: 8 } },
    },
    content: {
      value: {
        id,
        type: 1337,
        value: {
          title,
          altText: altText ?? title,
        },
      },
    },
  };
}

function makeButtonBlock(label: string, id = 'btn-001') {
  return {
    layout: {
      desktop: { start: { x: 1, y: 5 }, end: { x: 8, y: 7 } },
      mobile: { start: { x: 1, y: 5 }, end: { x: 12, y: 7 } },
    },
    content: {
      value: {
        id,
        type: 46,
        value: {
          label,
        },
      },
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('summarizePageSections', () => {
  it('returns empty structure for empty sections array', () => {
    const result = summarizePageSections([]);
    expect(result.sectionCount).toBe(0);
    expect(result.sections).toEqual([]);
  });

  it('summarizes a single section with no blocks', () => {
    const sections = [makeSection({ id: 'sec-1', sectionName: 'Hero' })];
    const result = summarizePageSections(sections);

    expect(result.sectionCount).toBe(1);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].id).toBe('sec-1');
    expect(result.sections[0].name).toBe('Hero');
    expect(result.sections[0].index).toBe(0);
    expect(result.sections[0].blockCount).toBe(0);
    expect(result.sections[0].blocks).toEqual([]);
  });

  it('extracts text block snippets with HTML stripping', () => {
    const sections = [
      makeSection({
        id: 'sec-1',
        sectionName: 'About',
        fluidEngineContext: {
          gridContents: [
            makeTextBlock('<h2>About Us</h2><p>We are a family-owned restaurant in New York City.</p>'),
          ],
        },
      }),
    ];

    const result = summarizePageSections(sections);
    expect(result.sections[0].blockCount).toBe(1);
    expect(result.sections[0].blocks[0].type).toBe('text');
    expect(result.sections[0].blocks[0].textSnippet).toBe('About Us We are a family-owned restaurant in New York City.');
  });

  it('truncates text snippets longer than 100 chars', () => {
    const longText = '<p>' + 'A'.repeat(200) + '</p>';
    const sections = [
      makeSection({
        fluidEngineContext: {
          gridContents: [makeTextBlock(longText)],
        },
      }),
    ];

    const result = summarizePageSections(sections);
    const snippet = result.sections[0].blocks[0].textSnippet!;
    expect(snippet.length).toBe(103); // 100 + '...'
    expect(snippet.endsWith('...')).toBe(true);
  });

  it('extracts image block alt text', () => {
    const sections = [
      makeSection({
        fluidEngineContext: {
          gridContents: [
            makeImageBlock('Chef Maria portrait', 'Portrait of Chef Maria in the kitchen'),
          ],
        },
      }),
    ];

    const result = summarizePageSections(sections);
    expect(result.sections[0].blocks[0].type).toBe('image');
    expect(result.sections[0].blocks[0].imageAlt).toBe('Portrait of Chef Maria in the kitchen');
  });

  it('extracts button block label', () => {
    const sections = [
      makeSection({
        fluidEngineContext: {
          gridContents: [makeButtonBlock('Reserve Now')],
        },
      }),
    ];

    const result = summarizePageSections(sections);
    expect(result.sections[0].blocks[0].type).toBe('button');
    expect(result.sections[0].blocks[0].buttonLabel).toBe('Reserve Now');
  });

  it('handles multiple sections with mixed block types', () => {
    const sections = [
      makeSection({
        id: 'hero',
        sectionName: 'Hero Section',
        fluidEngineContext: {
          gridContents: [
            makeTextBlock('<h1>Welcome to Smyth Tavern</h1>', 'txt-1'),
            makeImageBlock('Restaurant interior', undefined, 'img-1'),
            makeButtonBlock('View Menu'),
          ],
        },
      }),
      makeSection({
        id: 'about',
        sectionName: 'About Section',
        fluidEngineContext: {
          gridContents: [
            makeTextBlock('<h2>Our Story</h2><p>Founded in 2020...</p>', 'txt-2'),
          ],
        },
      }),
      makeSection({
        id: 'contact',
        sectionName: 'Contact Section',
        fluidEngineContext: {
          gridContents: [],
        },
      }),
    ];

    const result = summarizePageSections(sections);

    expect(result.sectionCount).toBe(3);

    // Hero section
    expect(result.sections[0].id).toBe('hero');
    expect(result.sections[0].index).toBe(0);
    expect(result.sections[0].blockCount).toBe(3);
    expect(result.sections[0].blocks[0].type).toBe('text');
    expect(result.sections[0].blocks[0].textSnippet).toBe('Welcome to Smyth Tavern');
    expect(result.sections[0].blocks[1].type).toBe('image');
    expect(result.sections[0].blocks[2].type).toBe('button');
    expect(result.sections[0].blocks[2].buttonLabel).toBe('View Menu');

    // About section
    expect(result.sections[1].id).toBe('about');
    expect(result.sections[1].index).toBe(1);
    expect(result.sections[1].blockCount).toBe(1);
    expect(result.sections[1].blocks[0].textSnippet).toBe('Our Story Founded in 2020...');

    // Contact section (empty)
    expect(result.sections[2].id).toBe('contact');
    expect(result.sections[2].index).toBe(2);
    expect(result.sections[2].blockCount).toBe(0);
  });

  it('handles sections without fluidEngineContext gracefully', () => {
    const sections: PageSection[] = [
      { id: 'sec-no-ctx', sectionName: 'Legacy Section' },
    ];

    const result = summarizePageSections(sections);
    expect(result.sectionCount).toBe(1);
    expect(result.sections[0].blockCount).toBe(0);
    expect(result.sections[0].blocks).toEqual([]);
  });

  it('falls back to section name "Section N" when sectionName is missing', () => {
    const sections: PageSection[] = [
      { id: 'sec-noname', sectionName: undefined as unknown as string },
    ];

    const result = summarizePageSections(sections);
    expect(result.sections[0].name).toBe('Section 1');
  });

  it('handles unknown block types gracefully', () => {
    const sections = [
      makeSection({
        fluidEngineContext: {
          gridContents: [
            {
              content: {
                value: {
                  id: 'unknown-1',
                  type: 99999,
                  value: { text: 'Some custom block' },
                },
              },
            },
          ],
        },
      }),
    ];

    const result = summarizePageSections(sections);
    expect(result.sections[0].blocks[0].type).toBe('unknown(99999)');
    expect(result.sections[0].blocks[0].textSnippet).toBe('Some custom block');
  });

  it('strips HTML entities correctly', () => {
    const sections = [
      makeSection({
        fluidEngineContext: {
          gridContents: [
            makeTextBlock('<p>Tom &amp; Jerry&apos;s &quot;Café&quot; — best in NYC</p>'),
          ],
        },
      }),
    ];

    const result = summarizePageSections(sections);
    expect(result.sections[0].blocks[0].textSnippet).toBe("Tom & Jerry's \"Café\" — best in NYC");
  });

  it('handles image block with title fallback when altText is missing', () => {
    const sections = [
      makeSection({
        fluidEngineContext: {
          gridContents: [
            {
              content: {
                value: {
                  id: 'img-notalt',
                  type: 1337,
                  value: {
                    title: 'Restaurant exterior',
                    description: 'View of the building',
                    // no altText
                  },
                },
              },
            },
          ],
        },
      }),
    ];

    const result = summarizePageSections(sections);
    // altText is checked first, then title, then description
    expect(result.sections[0].blocks[0].imageAlt).toBe('Restaurant exterior');
  });
});

// ── Design property extraction in summarizePageSections ──────────────────────

describe('summarizePageSections — design properties', () => {
  it('extracts text styles from text blocks', () => {
    const sections = [
      makeSection({
        fluidEngineContext: {
          gridContents: [
            makeTextBlock('<h2 style="text-align:center;color:#333;">Our Menu</h2>'),
          ],
        },
      }),
    ];

    const result = summarizePageSections(sections);
    const block = result.sections[0].blocks[0];
    expect(block.textStyles).toBeDefined();
    expect(block.textStyles!.headingTag).toBe('h2');
    expect(block.textStyles!.alignment).toBe('center');
    expect(block.textStyles!.color).toBe('#333');
  });

  it('extracts grid span from block layout', () => {
    const sections = [
      makeSection({
        fluidEngineContext: {
          gridContents: [
            makeTextBlock('<p>Half width</p>'),  // default layout: x:1-24
          ],
        },
      }),
    ];

    const result = summarizePageSections(sections);
    const block = result.sections[0].blocks[0];
    expect(block.gridSpan).toBeDefined();
    expect(block.gridSpan!.columns).toBe(23);  // 24 - 1
    expect(block.gridSpan!.startX).toBe(1);
    expect(block.gridSpan!.endX).toBe(24);
  });

  it('extracts links from text block HTML', () => {
    const sections = [
      makeSection({
        fluidEngineContext: {
          gridContents: [
            makeTextBlock('<p>Visit <a href="https://example.com">our site</a> for more.</p>'),
          ],
        },
      }),
    ];

    const result = summarizePageSections(sections);
    const block = result.sections[0].blocks[0];
    expect(block.links).toHaveLength(1);
    expect(block.links![0].text).toBe('our site');
    expect(block.links![0].href).toBe('https://example.com');
  });

  it('extracts image subtitle and linkTo', () => {
    const sections = [
      makeSection({
        fluidEngineContext: {
          gridContents: [
            {
              layout: {
                desktop: { start: { x: 1, y: 1 }, end: { x: 12, y: 8 } },
                mobile: { start: { x: 1, y: 1 }, end: { x: 12, y: 8 } },
              },
              content: {
                value: {
                  id: 'img-sub',
                  type: 1337,
                  value: {
                    title: 'Chef photo',
                    altText: 'Chef Maria',
                    subtitle: 'Photo by John Smith',
                    linkTo: '/about-chef',
                  },
                },
              },
            },
          ],
        },
      }),
    ];

    const result = summarizePageSections(sections);
    const block = result.sections[0].blocks[0];
    expect(block.imageAlt).toBe('Chef Maria');
    expect(block.imageSubtitle).toBe('Photo by John Smith');
    expect(block.imageLinkTo).toBe('/about-chef');
  });

  it('extracts section design properties', () => {
    const sections: PageSection[] = [
      {
        id: 'sec-dark',
        sectionName: 'Dark Hero',
        sectionTheme: 'Dark',
        sectionHeight: 'large',
        contentWidth: 'inset',
        fluidEngineContext: {
          gridContents: [],
        },
      } as unknown as PageSection,
    ];

    const result = summarizePageSections(sections);
    expect(result.sections[0].design).toBeDefined();
    expect(result.sections[0].design!.theme).toBe('Dark');
    expect(result.sections[0].design!.sectionHeight).toBe('large');
    expect(result.sections[0].design!.contentWidth).toBe('inset');
  });

  it('marks hidden blocks with visible=false', () => {
    const sections = [
      makeSection({
        fluidEngineContext: {
          gridContents: [
            {
              layout: {
                desktop: { start: { x: 1, y: 1 }, end: { x: 24, y: 4 }, visible: false },
                mobile: { start: { x: 1, y: 1 }, end: { x: 12, y: 4 } },
              },
              content: {
                value: {
                  id: 'hidden-block',
                  type: 2,
                  value: { source: '<p>Hidden text</p>', html: '<p>Hidden text</p>' },
                },
              },
            },
          ],
        },
      }),
    ];

    const result = summarizePageSections(sections);
    expect(result.sections[0].blocks[0].visible).toBe(false);
  });
});

// ── PageStructure type tests ────────────────────────────────────────────────

describe('PageStructure types', () => {
  it('PageStructure has required fields', () => {
    const ps: PageStructure = {
      sectionCount: 2,
      sections: [
        {
          id: 'sec-1',
          index: 0,
          name: 'Hero',
          blockCount: 1,
          blocks: [{ type: 'text', textSnippet: 'Hello' }],
        },
        {
          id: 'sec-2',
          index: 1,
          name: 'Footer',
          blockCount: 0,
          blocks: [],
        },
      ],
    };

    expect(ps.sectionCount).toBe(2);
    expect(ps.sections).toHaveLength(2);
    expect(ps.sections[0].blocks[0].type).toBe('text');
  });
});
