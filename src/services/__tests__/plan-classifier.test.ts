import { describe, it, expect } from 'vitest';
import { classifyPlanForApi, type PlanClassification } from '../plan-classifier.js';
import type { ContentPlan, ContentOperation, ContentSpec } from '../../agents/types.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeOp(overrides: Partial<ContentOperation> = {}): ContentOperation {
  return {
    taskId: 'task-1',
    siteId: 'test-site',
    targetPage: 'home',
    operationType: 'modify_text',
    placement: 'hero section',
    content: { heading: 'Test' },
    editorInstruction: 'Edit the text',
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

// ── Tests ──────────────────────────────────────────────────────────────────

describe('classifyPlanForApi', () => {
  describe('full_api classification', () => {
    it('classifies empty plan as browser_required', () => {
      const result = classifyPlanForApi(makePlan([]));
      expect(result.capability).toBe('browser_required');
      expect(result.apiOperations).toHaveLength(0);
      expect(result.browserOperations).toHaveLength(0);
    });

    it('classifies single modify_text as full_api', () => {
      const plan = makePlan([makeOp({ operationType: 'modify_text' })]);
      const result = classifyPlanForApi(plan);
      expect(result.capability).toBe('full_api');
      expect(result.apiOperations).toHaveLength(1);
      expect(result.browserOperations).toHaveLength(0);
    });

    it('classifies create_page as full_api', () => {
      const plan = makePlan([makeOp({ operationType: 'create_page' })]);
      const result = classifyPlanForApi(plan);
      expect(result.capability).toBe('full_api');
    });

    it('classifies add_section blank_api as full_api', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'add_section',
          content: { contentStrategy: 'blank_api', apiBlocks: [] },
        }),
      ]);
      const result = classifyPlanForApi(plan);
      expect(result.capability).toBe('full_api');
    });

    it('classifies add_section template with category+index as full_api', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'add_section',
          content: {
            contentStrategy: 'template',
            templateCategory: 'CONTACT',
            templateIndex: 0,
          },
        }),
      ]);
      const result = classifyPlanForApi(plan);
      expect(result.capability).toBe('full_api');
    });

    it('classifies replace_image as full_api', () => {
      const plan = makePlan([makeOp({ operationType: 'replace_image' })]);
      expect(classifyPlanForApi(plan).capability).toBe('full_api');
    });

    it('classifies remove_block as full_api', () => {
      const plan = makePlan([makeOp({ operationType: 'remove_block' })]);
      expect(classifyPlanForApi(plan).capability).toBe('full_api');
    });

    it('classifies modify_block as full_api', () => {
      const plan = makePlan([makeOp({ operationType: 'modify_block' })]);
      expect(classifyPlanForApi(plan).capability).toBe('full_api');
    });

    it('classifies modify_style as full_api', () => {
      const plan = makePlan([makeOp({ operationType: 'modify_style' })]);
      expect(classifyPlanForApi(plan).capability).toBe('full_api');
    });

    it('classifies add_block as full_api', () => {
      const plan = makePlan([makeOp({ operationType: 'add_block' })]);
      expect(classifyPlanForApi(plan).capability).toBe('full_api');
    });

    it('classifies add_gallery as full_api', () => {
      const plan = makePlan([makeOp({ operationType: 'add_gallery' })]);
      expect(classifyPlanForApi(plan).capability).toBe('full_api');
    });

    it('classifies multi-op plan with all API-capable ops as full_api', () => {
      const plan = makePlan([
        makeOp({ operationType: 'create_page' }),
        makeOp({ operationType: 'add_section', content: { contentStrategy: 'blank_api' } }),
        makeOp({ operationType: 'modify_text' }),
        makeOp({ operationType: 'modify_style' }),
      ]);
      const result = classifyPlanForApi(plan);
      expect(result.capability).toBe('full_api');
      expect(result.apiOperations).toHaveLength(4);
    });
  });

  describe('browser_required classification', () => {
    it('classifies manual strategy as browser_required', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'add_section',
          content: { contentStrategy: 'manual' },
        }),
      ]);
      const result = classifyPlanForApi(plan);
      expect(result.capability).toBe('browser_required');
      expect(result.browserOperations).toHaveLength(1);
    });

    it('classifies template without category as browser_required', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'add_section',
          content: { contentStrategy: 'template', templateIndex: 0 },
        }),
      ]);
      const result = classifyPlanForApi(plan);
      expect(result.capability).toBe('browser_required');
    });

    it('classifies template without index as browser_required', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'add_section',
          content: { contentStrategy: 'template', templateCategory: 'CONTACT' },
        }),
      ]);
      const result = classifyPlanForApi(plan);
      expect(result.capability).toBe('browser_required');
    });

    it('classifies template with category+index+replacements as full_api', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'add_section',
          content: {
            contentStrategy: 'template',
            templateCategory: 'About',
            templateIndex: 1,
            replacements: {
              texts: [{ searchText: 'About Us', newText: 'Our Story' }],
              removeBlocks: ['Learn More'],
            },
          },
        }),
      ]);
      const result = classifyPlanForApi(plan);
      expect(result.capability).toBe('full_api');
    });

    it('classifies template with templateIndex 0 as full_api', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'add_section',
          content: {
            contentStrategy: 'template',
            templateCategory: 'Services',
            templateIndex: 0,
          },
        }),
      ]);
      const result = classifyPlanForApi(plan);
      expect(result.capability).toBe('full_api');
    });

    it('classifies add_section without strategy or apiBlocks as browser_required', () => {
      const plan = makePlan([
        makeOp({ operationType: 'add_section', content: {} }),
      ]);
      const result = classifyPlanForApi(plan);
      expect(result.capability).toBe('browser_required');
    });

    it('rejects replace_image with imageQuery but no imagePath', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'replace_image',
          content: { imageQuery: 'mountain landscape' },
        }),
      ]);
      const result = classifyPlanForApi(plan);
      expect(result.capability).toBe('browser_required');
    });

    it('rejects add_gallery with imageQuery but no imagePath', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'add_gallery',
          content: { imageQuery: 'team photos' },
        }),
      ]);
      const result = classifyPlanForApi(plan);
      expect(result.capability).toBe('browser_required');
    });

    it('rejects add_block image with imageQuery but no imagePath', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'add_block',
          content: { imageQuery: 'hero banner', blockType: 'image' },
        }),
      ]);
      const result = classifyPlanForApi(plan);
      expect(result.capability).toBe('browser_required');
    });
  });

  describe('imageQuery on non-image operations', () => {
    it('allows modify_text with imageQuery (non-image op, imageQuery is irrelevant)', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'modify_text',
          content: { heading: 'New heading', imageQuery: 'decorative context' },
        }),
      ]);
      const result = classifyPlanForApi(plan);
      expect(result.capability).toBe('full_api');
    });

    it('allows remove_block with imageQuery', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'remove_block',
          content: { heading: 'Old block', imageQuery: 'ref image' },
        }),
      ]);
      expect(classifyPlanForApi(plan).capability).toBe('full_api');
    });

    it('allows modify_block with imageQuery', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'modify_block',
          content: { button: { label: 'Click', url: '/page' }, imageQuery: 'ref' },
        }),
      ]);
      expect(classifyPlanForApi(plan).capability).toBe('full_api');
    });

    it('allows modify_style with imageQuery', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'modify_style',
          content: { sectionTheme: 'Dark', imageQuery: 'background ref' },
        }),
      ]);
      expect(classifyPlanForApi(plan).capability).toBe('full_api');
    });

    it('allows add_block text with imageQuery (blockType is not image)', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'add_block',
          content: { bodyText: 'Hello', blockType: 'text', imageQuery: 'decorative' },
        }),
      ]);
      expect(classifyPlanForApi(plan).capability).toBe('full_api');
    });
  });

  describe('inferred blank_api from apiBlocks', () => {
    it('classifies add_section with apiBlocks but no contentStrategy as full_api', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'add_section',
          content: {
            apiBlocks: [{ html: '<p>Hello</p>' }],
          },
        }),
      ]);
      const result = classifyPlanForApi(plan);
      expect(result.capability).toBe('full_api');
      expect(result.apiOperations).toHaveLength(1);
    });

    it('rejects add_section with empty apiBlocks and no contentStrategy', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'add_section',
          content: { apiBlocks: [] },
        }),
      ]);
      const result = classifyPlanForApi(plan);
      expect(result.capability).toBe('browser_required');
    });
  });

  describe('partial_api classification', () => {
    it('classifies mix of API and manual ops as partial_api', () => {
      const plan = makePlan([
        makeOp({ operationType: 'modify_text' }),
        makeOp({
          operationType: 'add_section',
          content: { contentStrategy: 'manual' },
        }),
      ]);
      const result = classifyPlanForApi(plan);
      expect(result.capability).toBe('partial_api');
      expect(result.apiOperations).toHaveLength(1);
      expect(result.browserOperations).toHaveLength(1);
    });

    it('separates API-capable and browser-required operations correctly', () => {
      const plan = makePlan([
        makeOp({ operationType: 'create_page' }),
        makeOp({ operationType: 'add_section', content: { contentStrategy: 'blank_api' } }),
        makeOp({ operationType: 'add_section', content: { contentStrategy: 'manual' } }),
        makeOp({ operationType: 'modify_text' }),
      ]);
      const result = classifyPlanForApi(plan);
      expect(result.capability).toBe('partial_api');
      expect(result.apiOperations).toHaveLength(3);
      expect(result.browserOperations).toHaveLength(1);
      expect(result.browserOperations[0].content.contentStrategy).toBe('manual');
    });
  });

  describe('reason messages', () => {
    it('provides reason for full_api', () => {
      const plan = makePlan([makeOp()]);
      const result = classifyPlanForApi(plan);
      expect(result.reason).toContain('1 operations can run via API');
    });

    it('provides reason for partial_api', () => {
      const plan = makePlan([
        makeOp(),
        makeOp({ content: { contentStrategy: 'manual' } }),
      ]);
      const result = classifyPlanForApi(plan);
      expect(result.reason).toContain('via API');
      expect(result.reason).toContain('via browser');
    });

    it('provides reason for browser_required', () => {
      const plan = makePlan([
        makeOp({ content: { contentStrategy: 'manual' } }),
      ]);
      const result = classifyPlanForApi(plan);
      expect(result.reason).toContain('manual strategy');
    });
  });

  // ── New operation types (Phase 2 API expansion) ───────────────────────

  describe('new operation types', () => {
    // modify_gallery_settings — always API-capable
    it('classifies modify_gallery_settings as full_api', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'modify_gallery_settings',
          content: { galleryColumns: 3, galleryLightbox: true },
        }),
      ]);
      expect(classifyPlanForApi(plan).capability).toBe('full_api');
    });

    // edit_footer — always API-capable
    it('classifies edit_footer as full_api', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'edit_footer',
          content: { bodyText: 'Footer content' },
        }),
      ]);
      expect(classifyPlanForApi(plan).capability).toBe('full_api');
    });

    // edit_css — requires cssCode
    it('classifies edit_css with cssCode as full_api', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'edit_css',
          content: { cssCode: 'body { color: red; }' },
        }),
      ]);
      expect(classifyPlanForApi(plan).capability).toBe('full_api');
    });

    it('classifies edit_css without cssCode as browser_required', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'edit_css',
          content: {},
        }),
      ]);
      expect(classifyPlanForApi(plan).capability).toBe('browser_required');
    });

    // edit_code_injection — requires header or footer
    it('classifies edit_code_injection with header as full_api', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'edit_code_injection',
          content: { codeInjectionHeader: '<script>ga("send")</script>' },
        }),
      ]);
      expect(classifyPlanForApi(plan).capability).toBe('full_api');
    });

    it('classifies edit_code_injection with footer as full_api', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'edit_code_injection',
          content: { codeInjectionFooter: '<script>footer()</script>' },
        }),
      ]);
      expect(classifyPlanForApi(plan).capability).toBe('full_api');
    });

    it('classifies edit_code_injection without either as browser_required', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'edit_code_injection',
          content: {},
        }),
      ]);
      expect(classifyPlanForApi(plan).capability).toBe('browser_required');
    });

    // reorder_sections — requires direction or order
    it('classifies reorder_sections with sectionDirection as full_api', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'reorder_sections',
          content: { sectionDirection: 'up' },
        }),
      ]);
      expect(classifyPlanForApi(plan).capability).toBe('full_api');
    });

    it('classifies reorder_sections with sectionOrder as full_api', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'reorder_sections',
          content: { sectionOrder: [2, 0, 1] },
        }),
      ]);
      expect(classifyPlanForApi(plan).capability).toBe('full_api');
    });

    it('classifies reorder_sections without either as browser_required', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'reorder_sections',
          content: {},
        }),
      ]);
      expect(classifyPlanForApi(plan).capability).toBe('browser_required');
    });

    // move_block — requires blockDirection
    it('classifies move_block with blockDirection as full_api', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'move_block',
          content: { blockDirection: 'left' },
        }),
      ]);
      expect(classifyPlanForApi(plan).capability).toBe('full_api');
    });

    it('classifies move_block without blockDirection as browser_required', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'move_block',
          content: {},
        }),
      ]);
      expect(classifyPlanForApi(plan).capability).toBe('browser_required');
    });

    // resize_block — requires width or height
    it('classifies resize_block with blockWidth as full_api', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'resize_block',
          content: { blockWidth: 'larger' },
        }),
      ]);
      expect(classifyPlanForApi(plan).capability).toBe('full_api');
    });

    it('classifies resize_block with blockHeight as full_api', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'resize_block',
          content: { blockHeight: 'taller' },
        }),
      ]);
      expect(classifyPlanForApi(plan).capability).toBe('full_api');
    });

    it('classifies resize_block without either as browser_required', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'resize_block',
          content: {},
        }),
      ]);
      expect(classifyPlanForApi(plan).capability).toBe('browser_required');
    });

    // create_blog_post — requires blogCollectionId
    it('classifies create_blog_post with blogCollectionId as full_api', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'create_blog_post',
          content: { blogCollectionId: 'col-123', blogTitle: 'Test', blogBody: '<p>Hi</p>' },
        }),
      ]);
      expect(classifyPlanForApi(plan).capability).toBe('full_api');
    });

    it('classifies create_blog_post without blogCollectionId as browser_required', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'create_blog_post',
          content: { blogTitle: 'Test', blogBody: '<p>Hi</p>' },
        }),
      ]);
      expect(classifyPlanForApi(plan).capability).toBe('browser_required');
    });

    // update_blog_post — requires both IDs
    it('classifies update_blog_post with both IDs as full_api', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'update_blog_post',
          content: { blogCollectionId: 'col-123', blogPostId: 'post-456', blogTitle: 'Updated' },
        }),
      ]);
      expect(classifyPlanForApi(plan).capability).toBe('full_api');
    });

    it('classifies update_blog_post with only collectionId as browser_required', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'update_blog_post',
          content: { blogCollectionId: 'col-123', blogTitle: 'Updated' },
        }),
      ]);
      expect(classifyPlanForApi(plan).capability).toBe('browser_required');
    });

    it('classifies update_blog_post with only postId as browser_required', () => {
      const plan = makePlan([
        makeOp({
          operationType: 'update_blog_post',
          content: { blogPostId: 'post-456', blogTitle: 'Updated' },
        }),
      ]);
      expect(classifyPlanForApi(plan).capability).toBe('browser_required');
    });
  });
});
