import { describe, it, expect } from 'vitest';
import type { ContentPlan, ContentOperation } from '../../../agents/types.js';
import { splitOperationsIntoPasses, shouldUseTwoPass } from '../execution.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeOp(overrides: Partial<ContentOperation> & Pick<ContentOperation, 'operationType'>): ContentOperation {
  return {
    taskId: 'task-1',
    siteId: 'test-site',
    targetPage: 'home',
    placement: 'below hero',
    content: {},
    editorInstruction: 'do something',
    ...overrides,
  };
}

function makePlan(operations: ContentOperation[]): ContentPlan {
  return {
    summary: 'Test plan',
    operations,
    sources: [],
    estimatedMinutes: 5,
  };
}

// ── splitOperationsIntoPasses ────────────────────────────────────────────────

describe('splitOperationsIntoPasses', () => {
  it('should put create_page ops in structural pass only', () => {
    const ops = [makeOp({ operationType: 'create_page', targetPage: 'new' })];
    const { structural, content } = splitOperationsIntoPasses(ops);

    expect(structural).toHaveLength(1);
    expect(structural[0].operationType).toBe('create_page');
    expect(content).toHaveLength(0);
  });

  it('should treat targetPage "new" as create_page (structural only)', () => {
    // Even if operationType is something else, targetPage 'new' triggers structural-only
    const ops = [makeOp({ operationType: 'add_section', targetPage: 'new' })];
    const { structural, content } = splitOperationsIntoPasses(ops);

    // targetPage 'new' makes isCreatePage true, so it goes structural-only
    expect(structural).toHaveLength(1);
    expect(content).toHaveLength(0);
  });

  it('should put add_section without content in structural pass only', () => {
    const ops = [makeOp({ operationType: 'add_section', content: {} })];
    const { structural, content } = splitOperationsIntoPasses(ops);

    expect(structural).toHaveLength(1);
    expect(content).toHaveLength(0);
  });

  it('should put add_section with text replacements in both passes', () => {
    const ops = [makeOp({
      operationType: 'add_section',
      content: {
        replacements: {
          texts: [{ searchText: 'Placeholder', newText: 'Real content' }],
        },
      },
    })];
    const { structural, content } = splitOperationsIntoPasses(ops);

    expect(structural).toHaveLength(1);
    expect(content).toHaveLength(1);
    expect(structural[0]).toBe(content[0]); // same reference
  });

  it('should put add_section with button replacements in both passes', () => {
    const ops = [makeOp({
      operationType: 'add_section',
      content: {
        replacements: {
          buttons: [{ searchText: 'Click Here', newLabel: 'Learn More', url: '/about' }],
        },
      },
    })];
    const { structural, content } = splitOperationsIntoPasses(ops);

    expect(structural).toHaveLength(1);
    expect(content).toHaveLength(1);
  });

  it('should put add_section with image replacements in both passes', () => {
    const ops = [makeOp({
      operationType: 'add_section',
      content: {
        replacements: {
          images: [{ searchText: 'hero-img', imagePath: '/uploads/hero.jpg', altText: 'Hero' }],
        },
      },
    })];
    const { structural, content } = splitOperationsIntoPasses(ops);

    expect(structural).toHaveLength(1);
    expect(content).toHaveLength(1);
  });

  it('should put add_section with removeBlocks in both passes', () => {
    const ops = [makeOp({
      operationType: 'add_section',
      content: {
        replacements: {
          removeBlocks: ['Learn More'],
        },
      },
    })];
    const { structural, content } = splitOperationsIntoPasses(ops);

    expect(structural).toHaveLength(1);
    expect(content).toHaveLength(1);
  });

  it('should put add_section with apiBlocks in both passes', () => {
    const ops = [makeOp({
      operationType: 'add_section',
      content: {
        contentStrategy: 'blank_api' as const,
        apiBlocks: [{ html: '<h2>Title</h2><p>Body text</p>' }],
      },
    })];
    const { structural, content } = splitOperationsIntoPasses(ops);

    expect(structural).toHaveLength(1);
    expect(content).toHaveLength(1);
  });

  it('should put add_section with style props in both passes', () => {
    const ops = [makeOp({
      operationType: 'add_section',
      content: {
        sectionTheme: 'Dark',
      },
    })];
    const { structural, content } = splitOperationsIntoPasses(ops);

    expect(structural).toHaveLength(1);
    expect(content).toHaveLength(1);
  });

  it('should put add_section with sectionPadding in both passes', () => {
    const ops = [makeOp({
      operationType: 'add_section',
      content: { sectionPadding: 'large' },
    })];
    const { structural, content } = splitOperationsIntoPasses(ops);

    expect(structural).toHaveLength(1);
    expect(content).toHaveLength(1);
  });

  it('should put add_section with blockSpacing in both passes', () => {
    const ops = [makeOp({
      operationType: 'add_section',
      content: { blockSpacing: 'small' },
    })];
    const { structural, content } = splitOperationsIntoPasses(ops);

    expect(structural).toHaveLength(1);
    expect(content).toHaveLength(1);
  });

  it('should put add_section with sectionHeight in both passes', () => {
    const ops = [makeOp({
      operationType: 'add_section',
      content: { sectionHeight: 'full' },
    })];
    const { structural, content } = splitOperationsIntoPasses(ops);

    expect(structural).toHaveLength(1);
    expect(content).toHaveLength(1);
  });

  it('should put add_section with contentWidth in both passes', () => {
    const ops = [makeOp({
      operationType: 'add_section',
      content: { contentWidth: 'full' },
    })];
    const { structural, content } = splitOperationsIntoPasses(ops);

    expect(structural).toHaveLength(1);
    expect(content).toHaveLength(1);
  });

  it('should put modify_text in content pass only', () => {
    const ops = [makeOp({ operationType: 'modify_text' })];
    const { structural, content } = splitOperationsIntoPasses(ops);

    expect(structural).toHaveLength(0);
    expect(content).toHaveLength(1);
    expect(content[0].operationType).toBe('modify_text');
  });

  it('should put replace_image in content pass only', () => {
    const ops = [makeOp({ operationType: 'replace_image' })];
    const { structural, content } = splitOperationsIntoPasses(ops);

    expect(structural).toHaveLength(0);
    expect(content).toHaveLength(1);
  });

  it('should put remove_block in content pass only', () => {
    const ops = [makeOp({ operationType: 'remove_block' })];
    const { structural, content } = splitOperationsIntoPasses(ops);

    expect(structural).toHaveLength(0);
    expect(content).toHaveLength(1);
  });

  it('should put add_block in content pass only', () => {
    const ops = [makeOp({ operationType: 'add_block' })];
    const { structural, content } = splitOperationsIntoPasses(ops);

    expect(structural).toHaveLength(0);
    expect(content).toHaveLength(1);
  });

  it('should put modify_block in content pass only', () => {
    const ops = [makeOp({ operationType: 'modify_block' })];
    const { structural, content } = splitOperationsIntoPasses(ops);

    expect(structural).toHaveLength(0);
    expect(content).toHaveLength(1);
  });

  it('should put modify_style in content pass only', () => {
    const ops = [makeOp({ operationType: 'modify_style' })];
    const { structural, content } = splitOperationsIntoPasses(ops);

    expect(structural).toHaveLength(0);
    expect(content).toHaveLength(1);
  });

  it('should handle empty operations array', () => {
    const { structural, content } = splitOperationsIntoPasses([]);

    expect(structural).toHaveLength(0);
    expect(content).toHaveLength(0);
  });

  it('should correctly split mixed operations across passes', () => {
    const ops = [
      makeOp({ operationType: 'create_page', targetPage: 'new' }),
      makeOp({
        operationType: 'add_section',
        content: {
          replacements: { texts: [{ searchText: 'X', newText: 'Y' }] },
        },
      }),
      makeOp({ operationType: 'modify_text' }),
      makeOp({ operationType: 'add_section', content: {} }), // no content
      makeOp({
        operationType: 'add_section',
        content: {
          contentStrategy: 'blank_api' as const,
          apiBlocks: [{ html: '<p>Text</p>' }],
        },
      }),
      makeOp({ operationType: 'replace_image' }),
    ];
    const { structural, content } = splitOperationsIntoPasses(ops);

    // structural: create_page + 3 add_sections = 4
    expect(structural).toHaveLength(4);
    expect(structural[0].operationType).toBe('create_page');
    expect(structural[1].operationType).toBe('add_section');
    expect(structural[2].operationType).toBe('add_section');
    expect(structural[3].operationType).toBe('add_section');

    // content: add_section(with replacements) + modify_text + add_section(with apiBlocks) + replace_image = 4
    expect(content).toHaveLength(4);
    expect(content[0].operationType).toBe('add_section'); // with replacements
    expect(content[1].operationType).toBe('modify_text');
    expect(content[2].operationType).toBe('add_section'); // with apiBlocks
    expect(content[3].operationType).toBe('replace_image');
  });

  it('should not duplicate add_section with empty replacements', () => {
    const ops = [makeOp({
      operationType: 'add_section',
      content: {
        replacements: {
          texts: [],
          buttons: [],
          images: [],
          removeBlocks: [],
        },
      },
    })];
    const { structural, content } = splitOperationsIntoPasses(ops);

    expect(structural).toHaveLength(1);
    expect(content).toHaveLength(0); // empty arrays → no content
  });

  it('should not duplicate add_section with empty apiBlocks', () => {
    const ops = [makeOp({
      operationType: 'add_section',
      content: {
        apiBlocks: [],
      },
    })];
    const { structural, content } = splitOperationsIntoPasses(ops);

    expect(structural).toHaveLength(1);
    expect(content).toHaveLength(0);
  });
});

// ── shouldUseTwoPass ────────────────────────────────────────────────────────

describe('shouldUseTwoPass', () => {
  it('should return true when plan has a create_page operation', () => {
    const plan = makePlan([
      makeOp({ operationType: 'create_page', targetPage: 'new' }),
      makeOp({ operationType: 'add_section' }),
    ]);

    expect(shouldUseTwoPass(plan)).toBe(true);
  });

  it('should return true when targetPage is "new" (implies page creation)', () => {
    const plan = makePlan([
      makeOp({ operationType: 'add_section', targetPage: 'new' }),
    ]);

    expect(shouldUseTwoPass(plan)).toBe(true);
  });

  it('should return true when plan has exactly 3 add_section operations', () => {
    const plan = makePlan([
      makeOp({ operationType: 'add_section' }),
      makeOp({ operationType: 'add_section' }),
      makeOp({ operationType: 'add_section' }),
    ]);

    expect(shouldUseTwoPass(plan)).toBe(true);
  });

  it('should return true when plan has more than 3 add_section operations', () => {
    const plan = makePlan([
      makeOp({ operationType: 'add_section' }),
      makeOp({ operationType: 'add_section' }),
      makeOp({ operationType: 'add_section' }),
      makeOp({ operationType: 'add_section' }),
      makeOp({ operationType: 'add_section' }),
    ]);

    expect(shouldUseTwoPass(plan)).toBe(true);
  });

  it('should return false when plan has only 2 add_section operations', () => {
    const plan = makePlan([
      makeOp({ operationType: 'add_section' }),
      makeOp({ operationType: 'add_section' }),
    ]);

    expect(shouldUseTwoPass(plan)).toBe(false);
  });

  it('should return false when plan has only 1 add_section operation', () => {
    const plan = makePlan([
      makeOp({ operationType: 'add_section' }),
      makeOp({ operationType: 'modify_text' }),
    ]);

    expect(shouldUseTwoPass(plan)).toBe(false);
  });

  it('should return false when plan has no section additions and no page creation', () => {
    const plan = makePlan([
      makeOp({ operationType: 'modify_text' }),
      makeOp({ operationType: 'replace_image' }),
      makeOp({ operationType: 'remove_block' }),
    ]);

    expect(shouldUseTwoPass(plan)).toBe(false);
  });

  it('should return false for a simple modify_text only plan', () => {
    const plan = makePlan([
      makeOp({ operationType: 'modify_text' }),
    ]);

    expect(shouldUseTwoPass(plan)).toBe(false);
  });

  it('should return false for an empty plan', () => {
    const plan = makePlan([]);

    expect(shouldUseTwoPass(plan)).toBe(false);
  });

  it('should count only add_section for threshold, not other types', () => {
    const plan = makePlan([
      makeOp({ operationType: 'add_section' }),
      makeOp({ operationType: 'add_section' }),
      makeOp({ operationType: 'modify_text' }),
      makeOp({ operationType: 'replace_image' }),
      makeOp({ operationType: 'remove_block' }),
      makeOp({ operationType: 'add_block' }),
    ]);

    // Only 2 add_section ops — below threshold of 3
    expect(shouldUseTwoPass(plan)).toBe(false);
  });

  it('should return true with create_page even if no add_section ops', () => {
    const plan = makePlan([
      makeOp({ operationType: 'create_page', targetPage: 'new' }),
      makeOp({ operationType: 'modify_text' }),
    ]);

    expect(shouldUseTwoPass(plan)).toBe(true);
  });

  it('should return true when both conditions are met (page creation + 3+ sections)', () => {
    const plan = makePlan([
      makeOp({ operationType: 'create_page', targetPage: 'new' }),
      makeOp({ operationType: 'add_section' }),
      makeOp({ operationType: 'add_section' }),
      makeOp({ operationType: 'add_section' }),
    ]);

    expect(shouldUseTwoPass(plan)).toBe(true);
  });
});
