import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  contentMatches,
  stripHtmlForComparison,
  similarityRatio,
  validateOperation,
  formatValidationForSupervisor,
  capturePreSnapshot,
  type ValidationResult,
  type PreOperationSnapshot,
} from '../content-validator.js';
import type { ContentOperation, ContentSpec } from '../../agents/types.js';
import type { ContentSaveClient, PageSection, GridContent, BlockLayout, PageSectionsData } from '../content-save.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const STUB_LAYOUT: BlockLayout = {
  mobile: { start: { x: 1, y: 0 }, end: { x: 9, y: 3 } },
  desktop: { start: { x: 1, y: 0 }, end: { x: 13, y: 3 } },
};

function makeTextBlock(blockId: string, html: string): GridContent {
  return {
    layout: { ...STUB_LAYOUT },
    content: {
      value: {
        id: blockId,
        type: 2,
        value: {
          engine: 'wysiwyg',
          source: html,
          html,
          textAttributes: [],
        },
      },
    },
  };
}

function makeImageBlock(blockId: string, meta: { title?: string; altText?: string; description?: string }): GridContent {
  return {
    layout: { ...STUB_LAYOUT },
    content: {
      value: {
        id: blockId,
        type: 1337,
        value: {
          ...meta,
        } as Record<string, unknown>,
      },
    },
  };
}

function makeSections(...blocks: GridContent[]): PageSection[] {
  return [
    {
      id: 'section-1',
      sectionName: 'FLUID_ENGINE',
      fluidEngineContext: {
        gridContents: blocks,
        gridSettings: {
          breakpointSettings: { desktop: { columns: 24 } },
        },
      },
    },
  ];
}

function makeOperation(overrides: Partial<ContentOperation> & { operationType: ContentOperation['operationType'] }): ContentOperation {
  return {
    taskId: 'test-task',
    siteId: 'test-site',
    targetPage: 'home',
    placement: 'below hero',
    editorInstruction: 'Test instruction',
    content: {} as ContentSpec,
    ...overrides,
  };
}

function mockClient(sections: PageSection[]): ContentSaveClient {
  return {
    getPageSections: vi.fn().mockResolvedValue({ sections } as PageSectionsData),
  } as unknown as ContentSaveClient;
}

// ── stripHtmlForComparison ───────────────────────────────────────────────────

describe('stripHtmlForComparison', () => {
  it('strips HTML tags', () => {
    expect(stripHtmlForComparison('<p>Hello <strong>world</strong></p>')).toBe('Hello world');
  });

  it('decodes HTML entities', () => {
    expect(stripHtmlForComparison('Tom &amp; Jerry &lt;3&gt;')).toBe('Tom & Jerry <3>');
  });

  it('normalizes whitespace', () => {
    expect(stripHtmlForComparison('  hello   world  \n\t foo  ')).toBe('hello world foo');
  });

  it('handles &nbsp;', () => {
    expect(stripHtmlForComparison('hello&nbsp;world')).toBe('hello world');
  });

  it('handles &quot; and &#39;', () => {
    expect(stripHtmlForComparison('She said &quot;hello&#39;s&quot;')).toBe("She said \"hello's\"");
  });

  it('returns empty string for empty input', () => {
    expect(stripHtmlForComparison('')).toBe('');
  });

  it('handles complex nested HTML', () => {
    const html = '<div class="sqs-block-content"><h2 style="white-space:pre-wrap;">About Us</h2><p>We are a team.</p></div>';
    expect(stripHtmlForComparison(html)).toBe('About Us We are a team.');
  });
});

// ── contentMatches ───────────────────────────────────────────────────────────

describe('contentMatches', () => {
  it('matches exact text', () => {
    expect(contentMatches('Hello world', 'Hello world')).toBe(true);
  });

  it('matches when HTML is stripped', () => {
    expect(contentMatches(
      'About Us',
      '<h2 style="white-space:pre-wrap;">About Us</h2>',
    )).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(contentMatches('HELLO WORLD', 'hello world')).toBe(true);
  });

  it('matches when expected is contained in actual', () => {
    expect(contentMatches('About Us', 'About Us - Our Story and Values')).toBe(true);
  });

  it('fails when texts are completely different', () => {
    expect(contentMatches('Hello world', 'Goodbye universe')).toBe(false);
  });

  it('matches with minor differences within threshold', () => {
    expect(contentMatches(
      'We are a professional team dedicated to excellence',
      'We are a professional team dedicated to excellenc',  // one char off
    )).toBe(true);
  });

  it('fails when difference exceeds threshold', () => {
    expect(contentMatches('Hello', 'Completely different text here', 0.8)).toBe(false);
  });

  it('handles custom threshold', () => {
    expect(contentMatches('abc', 'abx', 0.5)).toBe(true);
    expect(contentMatches('abc', 'xyz', 0.5)).toBe(false);
  });

  it('handles empty expected — fails', () => {
    expect(contentMatches('', 'some text')).toBe(false);
  });

  it('handles both empty — passes', () => {
    expect(contentMatches('', '')).toBe(true);
  });

  it('normalizes whitespace before comparing', () => {
    expect(contentMatches('  hello   world  ', 'hello world')).toBe(true);
  });

  it('matches rich Squarespace HTML against plain text', () => {
    expect(contentMatches(
      'Welcome to our restaurant',
      '<p class="" style="white-space:pre-wrap;">Welcome to our restaurant</p>',
    )).toBe(true);
  });
});

// ── similarityRatio ──────────────────────────────────────────────────────────

describe('similarityRatio', () => {
  it('returns 1 for identical strings', () => {
    expect(similarityRatio('hello', 'hello')).toBe(1);
  });

  it('returns 0 for completely different strings', () => {
    expect(similarityRatio('abc', 'xyz')).toBe(0);
  });

  it('returns 1 for two empty strings', () => {
    expect(similarityRatio('', '')).toBe(1);
  });

  it('returns 0 when one string is empty', () => {
    expect(similarityRatio('hello', '')).toBe(0);
    expect(similarityRatio('', 'hello')).toBe(0);
  });

  it('gives high ratio for similar strings', () => {
    const ratio = similarityRatio('hello world', 'hello worl');
    expect(ratio).toBeGreaterThan(0.8);
  });

  it('gives low ratio for dissimilar strings', () => {
    const ratio = similarityRatio('hello', 'abcdefghij');
    expect(ratio).toBeLessThan(0.5);
  });
});

// ── validateOperation — add_section ──────────────────────────────────────────

describe('validateOperation — add_section', () => {
  it('passes when section count increased', async () => {
    const sections = makeSections(makeTextBlock('b1', '<p>Hello</p>'));
    // Add a second section
    sections.push({
      id: 'section-2',
      sectionName: 'FLUID_ENGINE',
      fluidEngineContext: { gridContents: [], gridSettings: {} },
    });

    const client = mockClient(sections);
    const preSnapshot: PreOperationSnapshot = { sectionCount: 1, blockCounts: new Map([[0, 1]]), capturedAt: Date.now() };

    const result = await validateOperation(
      makeOperation({ operationType: 'add_section' }),
      client,
      'page-123',
      preSnapshot,
    );

    expect(result.passed).toBe(true);
    expect(result.checks.some((c) => c.name === 'section_count_increased' && c.passed)).toBe(true);
    expect(result.checks.some((c) => c.name === 'new_section_exists' && c.passed)).toBe(true);
  });

  it('fails when section count did not increase', async () => {
    const sections = makeSections(makeTextBlock('b1', '<p>Hello</p>'));
    const client = mockClient(sections);
    const preSnapshot: PreOperationSnapshot = { sectionCount: 1, blockCounts: new Map([[0, 1]]), capturedAt: Date.now() };

    const result = await validateOperation(
      makeOperation({ operationType: 'add_section' }),
      client,
      'page-123',
      preSnapshot,
    );

    expect(result.passed).toBe(false);
    expect(result.checks.some((c) => c.name === 'section_count_increased' && !c.passed)).toBe(true);
  });

  it('passes without preSnapshot if section exists', async () => {
    const sections = makeSections(makeTextBlock('b1', '<p>Hello</p>'));
    const client = mockClient(sections);

    const result = await validateOperation(
      makeOperation({ operationType: 'add_section' }),
      client,
      'page-123',
    );

    expect(result.passed).toBe(true);
    expect(result.checks.some((c) => c.name === 'new_section_exists' && c.passed)).toBe(true);
  });
});

// ── validateOperation — modify_text ──────────────────────────────────────────

describe('validateOperation — modify_text', () => {
  it('passes when expected text is found on page', async () => {
    const sections = makeSections(
      makeTextBlock('b1', '<h2>About Us</h2>'),
      makeTextBlock('b2', '<p>We are a creative agency based in London.</p>'),
    );
    const client = mockClient(sections);

    const result = await validateOperation(
      makeOperation({
        operationType: 'modify_text',
        content: { heading: 'About Us', bodyText: 'creative agency based in London' } as ContentSpec,
      }),
      client,
      'page-123',
    );

    expect(result.passed).toBe(true);
    expect(result.checks.filter((c) => c.name === 'text_content_match').length).toBe(2);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it('fails when expected text is not found', async () => {
    const sections = makeSections(
      makeTextBlock('b1', '<h2>Contact Us</h2>'),
    );
    const client = mockClient(sections);

    const result = await validateOperation(
      makeOperation({
        operationType: 'modify_text',
        content: { heading: 'About Us' } as ContentSpec,
      }),
      client,
      'page-123',
    );

    expect(result.passed).toBe(false);
    expect(result.checks.some((c) => c.name === 'text_content_match' && !c.passed)).toBe(true);
  });

  it('fails when no heading or bodyText specified', async () => {
    const sections = makeSections(makeTextBlock('b1', '<p>Hello</p>'));
    const client = mockClient(sections);

    const result = await validateOperation(
      makeOperation({
        operationType: 'modify_text',
        content: {} as ContentSpec,
      }),
      client,
      'page-123',
    );

    expect(result.passed).toBe(false);
    expect(result.checks.some((c) => c.name === 'text_content_specified')).toBe(true);
  });
});

// ── validateOperation — add_block ────────────────────────────────────────────

describe('validateOperation — add_block', () => {
  it('passes when block count increased and content found', async () => {
    const sections = makeSections(
      makeTextBlock('b1', '<p>Existing</p>'),
      makeTextBlock('b2', '<p>New block content here</p>'),
    );
    const client = mockClient(sections);
    const preSnapshot: PreOperationSnapshot = {
      sectionCount: 1,
      blockCounts: new Map([[0, 1]]),
      capturedAt: Date.now(),
    };

    const result = await validateOperation(
      makeOperation({
        operationType: 'add_block',
        content: {
          apiBlocks: [{ html: '<p>New block content here</p>' }],
        } as ContentSpec,
      }),
      client,
      'page-123',
      preSnapshot,
    );

    expect(result.passed).toBe(true);
    expect(result.checks.some((c) => c.name === 'block_count_increased' && c.passed)).toBe(true);
    expect(result.checks.some((c) => c.name === 'block_text_present' && c.passed)).toBe(true);
  });

  it('fails when block count did not increase', async () => {
    const sections = makeSections(makeTextBlock('b1', '<p>Existing</p>'));
    const client = mockClient(sections);
    const preSnapshot: PreOperationSnapshot = {
      sectionCount: 1,
      blockCounts: new Map([[0, 1]]),
      capturedAt: Date.now(),
    };

    const result = await validateOperation(
      makeOperation({
        operationType: 'add_block',
        content: { apiBlocks: [{ html: '<p>Missing</p>' }] } as ContentSpec,
      }),
      client,
      'page-123',
      preSnapshot,
    );

    expect(result.passed).toBe(false);
  });
});

// ── validateOperation — remove_block ─────────────────────────────────────────

describe('validateOperation — remove_block', () => {
  it('passes when block count decreased and text is gone', async () => {
    // After removal: only one block remains
    const sections = makeSections(makeTextBlock('b1', '<p>Remaining content</p>'));
    const client = mockClient(sections);
    const preSnapshot: PreOperationSnapshot = {
      sectionCount: 1,
      blockCounts: new Map([[0, 2]]),
      capturedAt: Date.now(),
    };

    const result = await validateOperation(
      makeOperation({
        operationType: 'remove_block',
        content: { heading: 'Deleted heading' } as ContentSpec,
      }),
      client,
      'page-123',
      preSnapshot,
    );

    expect(result.passed).toBe(true);
    expect(result.checks.some((c) => c.name === 'block_count_decreased' && c.passed)).toBe(true);
    expect(result.checks.some((c) => c.name === 'removed_text_absent' && c.passed)).toBe(true);
  });

  it('fails when removed text is still present', async () => {
    const sections = makeSections(
      makeTextBlock('b1', '<p>Deleted heading</p>'),
      makeTextBlock('b2', '<p>Other content</p>'),
    );
    const client = mockClient(sections);
    const preSnapshot: PreOperationSnapshot = {
      sectionCount: 1,
      blockCounts: new Map([[0, 2]]),
      capturedAt: Date.now(),
    };

    const result = await validateOperation(
      makeOperation({
        operationType: 'remove_block',
        content: { heading: 'Deleted heading' } as ContentSpec,
      }),
      client,
      'page-123',
      preSnapshot,
    );

    expect(result.passed).toBe(false);
    expect(result.checks.some((c) => c.name === 'removed_text_absent' && !c.passed)).toBe(true);
  });
});

// ── validateOperation — replace_image ────────────────────────────────────────

describe('validateOperation — replace_image', () => {
  it('passes when image alt text matches', async () => {
    const sections = makeSections(
      makeImageBlock('img1', { title: 'Mountain landscape', altText: 'Beautiful mountain landscape at sunset' }),
    );
    const client = mockClient(sections);

    const result = await validateOperation(
      makeOperation({
        operationType: 'replace_image',
        content: { imageAltText: 'Beautiful mountain landscape at sunset' } as ContentSpec,
      }),
      client,
      'page-123',
    );

    expect(result.passed).toBe(true);
    expect(result.checks.some((c) => c.name === 'image_alt_match' && c.passed)).toBe(true);
  });

  it('fails when no matching image found', async () => {
    const sections = makeSections(
      makeImageBlock('img1', { title: 'Old image', altText: 'Old description' }),
    );
    const client = mockClient(sections);

    const result = await validateOperation(
      makeOperation({
        operationType: 'replace_image',
        content: { imageAltText: 'Brand new sunset photo' } as ContentSpec,
      }),
      client,
      'page-123',
    );

    expect(result.passed).toBe(false);
    expect(result.checks.some((c) => c.name === 'image_alt_match' && !c.passed)).toBe(true);
  });

  it('fails when no imageAltText specified', async () => {
    const sections = makeSections(makeImageBlock('img1', { title: 'Photo' }));
    const client = mockClient(sections);

    const result = await validateOperation(
      makeOperation({
        operationType: 'replace_image',
        content: {} as ContentSpec,
      }),
      client,
      'page-123',
    );

    expect(result.passed).toBe(false);
    expect(result.checks.some((c) => c.name === 'image_alt_specified')).toBe(true);
  });
});

// ── validateOperation — modify_style ─────────────────────────────────────────

describe('validateOperation — modify_style', () => {
  it('passes when page has sections', async () => {
    const sections = makeSections(makeTextBlock('b1', '<p>Hello</p>'));
    const client = mockClient(sections);

    const result = await validateOperation(
      makeOperation({
        operationType: 'modify_style',
        content: { sectionTheme: 'Dark' } as ContentSpec,
      }),
      client,
      'page-123',
    );

    // page_readable passes, section_theme_match depends on section JSON
    expect(result.checks.some((c) => c.name === 'page_readable' && c.passed)).toBe(true);
  });
});

// ── validateOperation — API error ────────────────────────────────────────────

describe('validateOperation — API errors', () => {
  it('returns failed check when API throws', async () => {
    const client = {
      getPageSections: vi.fn().mockRejectedValue(new Error('Network timeout')),
    } as unknown as ContentSaveClient;

    const result = await validateOperation(
      makeOperation({ operationType: 'add_section' }),
      client,
      'page-123',
    );

    expect(result.passed).toBe(false);
    expect(result.checks.some((c) => c.name === 'api_read' && !c.passed)).toBe(true);
    expect(result.checks[0].actual).toContain('Network timeout');
  });
});

// ── validateOperation — unknown operation type ───────────────────────────────

describe('validateOperation — unknown operation type', () => {
  it('returns api_readable check for unknown types', async () => {
    const sections = makeSections(makeTextBlock('b1', '<p>Hello</p>'));
    const client = mockClient(sections);

    const result = await validateOperation(
      makeOperation({ operationType: 'modify_block' as ContentOperation['operationType'] }),
      client,
      'page-123',
    );

    expect(result.passed).toBe(true);
    expect(result.checks.some((c) => c.name === 'api_readable')).toBe(true);
  });
});

// ── capturePreSnapshot ───────────────────────────────────────────────────────

describe('capturePreSnapshot', () => {
  it('captures section and block counts', async () => {
    const sections = [
      ...makeSections(makeTextBlock('b1', '<p>A</p>'), makeTextBlock('b2', '<p>B</p>')),
      {
        id: 'section-2',
        sectionName: 'FLUID_ENGINE',
        fluidEngineContext: { gridContents: [makeTextBlock('b3', '<p>C</p>')], gridSettings: {} },
      } as PageSection,
    ];
    const client = mockClient(sections);

    const snapshot = await capturePreSnapshot(client, 'page-123');

    expect(snapshot).not.toBeNull();
    expect(snapshot!.sectionCount).toBe(2);
    expect(snapshot!.blockCounts.get(0)).toBe(2);
    expect(snapshot!.blockCounts.get(1)).toBe(1);
  });

  it('returns null on API error', async () => {
    const client = {
      getPageSections: vi.fn().mockRejectedValue(new Error('fail')),
    } as unknown as ContentSaveClient;

    const snapshot = await capturePreSnapshot(client, 'page-123');
    expect(snapshot).toBeNull();
  });
});

// ── formatValidationForSupervisor ────────────────────────────────────────────

describe('formatValidationForSupervisor', () => {
  it('returns empty string for no results', () => {
    expect(formatValidationForSupervisor([])).toBe('');
  });

  it('formats passed results', () => {
    const results: ValidationResult[] = [
      {
        passed: true,
        operationType: 'add_section',
        checks: [
          { name: 'section_count_increased', passed: true, expected: '> 1 sections', actual: '2 sections' },
        ],
        summary: 'All 1 checks passed for add_section',
      },
    ];

    const output = formatValidationForSupervisor(results);
    expect(output).toContain('## Inline Validation Results');
    expect(output).toContain('PASS: add_section');
    expect(output).toContain('[OK] section_count_increased');
    expect(output).toContain('1 passed, 0 failed');
  });

  it('formats failed results', () => {
    const results: ValidationResult[] = [
      {
        passed: false,
        operationType: 'modify_text',
        checks: [
          { name: 'text_content_match', passed: false, expected: 'About Us', actual: 'Not found' },
        ],
        summary: '1/1 checks failed',
      },
    ];

    const output = formatValidationForSupervisor(results);
    expect(output).toContain('FAIL: modify_text');
    expect(output).toContain('[FAIL] text_content_match');
    expect(output).toContain('0 passed, 1 failed');
  });
});
