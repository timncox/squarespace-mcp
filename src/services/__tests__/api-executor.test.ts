import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ContentPlan, ContentOperation } from '../../agents/types.js';

// ── Mocks ──────────────────────────────────────────────────────────────────

// Mock logger
vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock dashboard events
vi.mock('../dashboard-events.js', () => ({
  dashboardEvents: {
    emit: vi.fn(),
  },
}));

// Mock plan operations
vi.mock('../../db/plan-operations.js', () => ({
  updateOperationStatus: vi.fn(),
}));

// Mock page-id-resolver
const mockResolvePageIds = vi.fn();
const mockCachePageIds = vi.fn();
vi.mock('../page-id-resolver.js', () => ({
  resolvePageIds: (...args: unknown[]) => mockResolvePageIds(...args),
  cachePageIds: (...args: unknown[]) => mockCachePageIds(...args),
}));

// Mock content-validator
vi.mock('../content-validator.js', () => ({
  capturePreSnapshot: vi.fn().mockResolvedValue(null),
  validateOperation: vi.fn().mockResolvedValue(null),
}));

// Mock ContentSaveClient
const mockGetPageSections = vi.fn();
const mockAddTextBlock = vi.fn();
const mockAddButtonBlock = vi.fn();
const mockAddImageBlock = vi.fn();
const mockAddImageBlockBatch = vi.fn();
const mockPatchTextBlock = vi.fn();
const mockUpdateTextBlock = vi.fn();
const mockUpdateButtonBlock = vi.fn();
const mockUpdateImageBlock = vi.fn();
const mockRemoveBlock = vi.fn();
const mockEditSectionStyle = vi.fn();
const mockAddBlankSection = vi.fn();
const mockCreatePageViaApi = vi.fn();
const mockMoveSection = vi.fn();
const mockDuplicateBlock = vi.fn();
const mockDuplicateSection = vi.fn();
const mockSwapBlocks = vi.fn();
const mockCheckSessionHealth = vi.fn();

vi.mock('../content-save.js', () => ({
  createContentSaveClient: () => ({
    getPageSections: mockGetPageSections,
    addTextBlock: mockAddTextBlock,
    addButtonBlock: mockAddButtonBlock,
    addImageBlock: mockAddImageBlock,
    addImageBlockBatch: mockAddImageBlockBatch,
    patchTextBlock: mockPatchTextBlock,
    updateTextBlock: mockUpdateTextBlock,
    updateButtonBlock: mockUpdateButtonBlock,
    updateImageBlock: mockUpdateImageBlock,
    removeBlock: mockRemoveBlock,
    editSectionStyle: mockEditSectionStyle,
    addBlankSection: mockAddBlankSection,
    createPageViaApi: mockCreatePageViaApi,
    moveSection: mockMoveSection,
    duplicateBlock: mockDuplicateBlock,
    duplicateSection: mockDuplicateSection,
    swapBlocks: mockSwapBlocks,
  }),
  ContentSaveClient: {
    checkSessionHealth: () => mockCheckSessionHealth(),
    buildRichHtml: (elements: unknown[]) => '<p>built html</p>',
  },
}));

// Mock section-catalog for template copy
const mockCopyTemplateSectionFromCatalog = vi.fn();
vi.mock('../section-catalog.js', () => ({
  copyTemplateSectionFromCatalog: (...args: unknown[]) => mockCopyTemplateSectionFromCatalog(...args),
}));

// Mock media upload
vi.mock('../media-upload.js', () => ({
  MediaUploadClient: class {
    constructor() {}
    async uploadImage() {
      return { status: 'success', assetUrl: 'https://images.squarespace.com/test.jpg', jobId: 'j1', libraryId: 'l1' };
    }
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────

import { executeContentPlanViaApi } from '../api-executor.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeOp(overrides: Partial<ContentOperation> = {}): ContentOperation {
  return {
    taskId: 'task-1',
    siteId: 'test-site',
    targetPage: 'home',
    operationType: 'modify_text',
    placement: 'hero section',
    content: { heading: 'Test', bodyText: 'New text' },
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

// ── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Default: healthy session
  mockCheckSessionHealth.mockReturnValue({ exists: true, hasCrumb: true, ageHours: 2 });

  // Default: page IDs resolve
  mockResolvePageIds.mockResolvedValue({
    pageSectionsId: 'ps-123',
    collectionId: 'col-456',
  });

  // Default: page has 2 sections
  mockGetPageSections.mockResolvedValue({
    sections: [
      { id: 's1', fluidEngineContext: { gridContents: [] } },
      { id: 's2', fluidEngineContext: { gridContents: [] } },
    ],
  });
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('executeContentPlanViaApi', () => {
  describe('session health', () => {
    it('fails fast when session is unhealthy', async () => {
      mockCheckSessionHealth.mockReturnValue({ exists: false, hasCrumb: false });

      const plan = makePlan([makeOp()]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.success).toBe(false);
      expect(result.failedOperations).toHaveLength(1);
      expect(result.summary).toContain('Session unhealthy');
    });

    it('fails fast when session has no crumb', async () => {
      mockCheckSessionHealth.mockReturnValue({ exists: true, hasCrumb: false });

      const plan = makePlan([makeOp()]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.success).toBe(false);
    });
  });

  describe('modify_text operations', () => {
    it('executes a simple text modification', async () => {
      mockPatchTextBlock.mockResolvedValue({ success: true });

      const plan = makePlan([
        makeOp({
          operationType: 'modify_text',
          content: { heading: 'Old heading', bodyText: 'New body text' },
        }),
      ]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.success).toBe(true);
      expect(result.operationResults).toHaveLength(1);
      expect(result.operationResults[0].success).toBe(true);
      expect(mockPatchTextBlock).toHaveBeenCalledWith('ps-123', 'col-456', 'Old heading', 'New body text');
    });

    it('falls back failed ops gracefully', async () => {
      mockPatchTextBlock.mockResolvedValue({ success: false, error: 'Block not found' });

      const plan = makePlan([makeOp({ operationType: 'modify_text', content: { bodyText: 'New' } })]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.success).toBe(false);
      expect(result.failedOperations).toHaveLength(1);
    });
  });

  describe('remove_block operations', () => {
    it('removes a block by search text', async () => {
      mockRemoveBlock.mockResolvedValue({ success: true });

      const plan = makePlan([
        makeOp({ operationType: 'remove_block', content: { heading: 'Happy Hour' } }),
      ]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.success).toBe(true);
      expect(mockRemoveBlock).toHaveBeenCalledWith('ps-123', 'col-456', 'Happy Hour');
    });
  });

  describe('modify_block operations', () => {
    it('updates a button block', async () => {
      mockUpdateButtonBlock.mockResolvedValue({ success: true });

      const plan = makePlan([
        makeOp({
          operationType: 'modify_block',
          content: { heading: 'Book Now', button: { label: 'Reserve', url: 'https://example.com' } },
        }),
      ]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.success).toBe(true);
      expect(mockUpdateButtonBlock).toHaveBeenCalledWith(
        'ps-123', 'col-456', 'Book Now',
        { newLabel: 'Reserve', url: 'https://example.com' },
      );
    });

    it('patches a text block via modify_block', async () => {
      mockPatchTextBlock.mockResolvedValue({ success: true });

      const plan = makePlan([
        makeOp({
          operationType: 'modify_block',
          content: { heading: 'About Us', bodyText: 'Updated about text' },
        }),
      ]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.success).toBe(true);
      expect(mockPatchTextBlock).toHaveBeenCalled();
    });
  });

  describe('modify_style operations', () => {
    it('applies section styles', async () => {
      mockEditSectionStyle.mockResolvedValue({ success: true, updatedFields: ['sectionTheme'] });

      const plan = makePlan([
        makeOp({
          operationType: 'modify_style',
          content: { sectionTheme: 'Dark', heading: 'Hero' },
        }),
      ]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.success).toBe(true);
      expect(mockEditSectionStyle).toHaveBeenCalledWith(
        'ps-123', 'col-456', 'Hero',
        expect.objectContaining({ sectionTheme: 'Dark' }),
      );
    });
  });

  describe('add_section blank_api', () => {
    it('adds a blank section with text blocks', async () => {
      mockAddBlankSection.mockResolvedValue({ success: true, sectionId: 'new-s1' });
      mockAddTextBlock.mockResolvedValue({ success: true, blockId: 'b1' });
      mockEditSectionStyle.mockResolvedValue({ success: true });

      const plan = makePlan([
        makeOp({
          operationType: 'add_section',
          content: {
            contentStrategy: 'blank_api',
            heading: 'About Us',
            apiBlocks: [{ html: '<h2>About Us</h2>' }, { html: '<p>Body text</p>' }],
            sectionTheme: 'Dark',
          },
        }),
      ]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.success).toBe(true);
      expect(mockAddBlankSection).toHaveBeenCalledWith('ps-123', 'col-456');
      expect(mockAddTextBlock).toHaveBeenCalledTimes(2);
      expect(mockEditSectionStyle).toHaveBeenCalled();
    });

    it('handles button apiBlocks', async () => {
      mockAddBlankSection.mockResolvedValue({ success: true, sectionId: 'new-s1' });
      mockAddButtonBlock.mockResolvedValue({ success: true, blockId: 'btn1' });

      const plan = makePlan([
        makeOp({
          operationType: 'add_section',
          content: {
            contentStrategy: 'blank_api',
            apiBlocks: [{ type: 'button' as const, label: 'Click Me', url: 'https://example.com' }],
          },
        }),
      ]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.success).toBe(true);
      expect(mockAddButtonBlock).toHaveBeenCalled();
    });

    it('handles image apiBlocks with upload', async () => {
      mockAddBlankSection.mockResolvedValue({ success: true, sectionId: 'new-s1' });
      mockAddImageBlock.mockResolvedValue({ success: true, blockId: 'img1' });

      const plan = makePlan([
        makeOp({
          operationType: 'add_section',
          content: {
            contentStrategy: 'blank_api',
            apiBlocks: [{ type: 'image' as const, imagePath: '/storage/uploads/test.jpg', altText: 'Test image' }],
          },
        }),
      ]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.success).toBe(true);
      expect(mockAddImageBlock).toHaveBeenCalled();
    });

    it('fails when addBlankSection fails', async () => {
      mockAddBlankSection.mockResolvedValue({ success: false, error: 'API error' });

      const plan = makePlan([
        makeOp({
          operationType: 'add_section',
          content: { contentStrategy: 'blank_api' },
        }),
      ]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.success).toBe(false);
      expect(result.failedOperations).toHaveLength(1);
    });
  });

  describe('create_page', () => {
    it('creates a page via API', async () => {
      mockCreatePageViaApi.mockResolvedValue({
        success: true,
        endpointAvailable: true,
        pageId: 'page-1',
        urlId: 'test-page',
      });

      const plan = makePlan([
        makeOp({
          operationType: 'create_page',
          targetPage: 'test-page',
          content: { heading: 'Test Page' },
        }),
      ]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.success).toBe(true);
      expect(mockCreatePageViaApi).toHaveBeenCalledWith('Test Page', 'test-page');
    });

    it('fails when no endpoint available', async () => {
      mockCreatePageViaApi.mockResolvedValue({
        success: false,
        endpointAvailable: false,
      });

      const plan = makePlan([
        makeOp({ operationType: 'create_page', content: { heading: 'New Page' } }),
      ]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.success).toBe(false);
      expect(result.failedOperations).toHaveLength(1);
    });
  });

  describe('add_block', () => {
    it('adds a text block to last section', async () => {
      mockAddTextBlock.mockResolvedValue({ success: true, blockId: 'b1' });

      const plan = makePlan([
        makeOp({
          operationType: 'add_block',
          content: { blockType: 'text', bodyText: 'New paragraph' },
        }),
      ]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.success).toBe(true);
      // Should add to section index 1 (last of 2 sections)
      expect(mockAddTextBlock).toHaveBeenCalledWith(
        'ps-123', 'col-456', 1,
        expect.stringContaining('New paragraph'),
      );
    });

    it('adds a button block', async () => {
      mockAddButtonBlock.mockResolvedValue({ success: true, blockId: 'btn1' });

      const plan = makePlan([
        makeOp({
          operationType: 'add_block',
          content: { blockType: 'button', button: { label: 'Click', url: 'https://example.com' } },
        }),
      ]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.success).toBe(true);
      expect(mockAddButtonBlock).toHaveBeenCalled();
    });
  });

  describe('multi-operation plans', () => {
    it('executes operations in dependency order', async () => {
      mockCreatePageViaApi.mockResolvedValue({
        success: true,
        endpointAvailable: true,
        urlId: 'new-page',
      });
      mockAddBlankSection.mockResolvedValue({ success: true, sectionId: 'new-s1' });
      mockAddTextBlock.mockResolvedValue({ success: true, blockId: 'b1' });
      mockEditSectionStyle.mockResolvedValue({ success: true });

      const plan = makePlan([
        makeOp({
          operationType: 'create_page',
          targetPage: 'new-page',
          content: { heading: 'New Page' },
        }),
        makeOp({
          operationType: 'add_section',
          targetPage: 'new-page',
          content: { contentStrategy: 'blank_api', apiBlocks: [{ html: '<h2>Hello</h2>' }] },
        }),
        makeOp({
          operationType: 'modify_style',
          targetPage: 'new-page',
          content: { sectionTheme: 'Dark' },
        }),
      ]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      // create_page should be called first
      expect(mockCreatePageViaApi).toHaveBeenCalled();
      // Then addBlankSection
      expect(mockAddBlankSection).toHaveBeenCalled();
      // Then editSectionStyle
      expect(mockEditSectionStyle).toHaveBeenCalled();
    });

    it('handles partial failures', async () => {
      mockPatchTextBlock.mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: false, error: 'Not found' });

      const plan = makePlan([
        makeOp({ operationType: 'modify_text', content: { bodyText: 'First edit' } }),
        makeOp({ operationType: 'modify_text', content: { bodyText: 'Second edit' } }),
      ]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.success).toBe(false);
      expect(result.operationResults).toHaveLength(2);
      expect(result.operationResults[0].success).toBe(true);
      expect(result.operationResults[1].success).toBe(false);
      expect(result.failedOperations).toHaveLength(1);
    });
  });

  describe('page ID resolution', () => {
    it('fails when page IDs cannot be resolved', async () => {
      mockResolvePageIds.mockResolvedValue(null);

      const plan = makePlan([makeOp({ operationType: 'modify_text' })]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.success).toBe(false);
      expect(result.failedOperations).toHaveLength(1);
      expect(result.operationResults[0].error).toContain('Could not resolve page context');
    });
  });

  describe('duplicate_block operations', () => {
    it('duplicates a block by search text', async () => {
      mockDuplicateBlock.mockResolvedValue({
        success: true,
        originalBlockId: 'orig-1',
        newBlockId: 'new-1',
        sectionId: 's1',
      });

      const plan = makePlan([
        makeOp({
          operationType: 'duplicate_block',
          content: { duplicateBlockSearchText: 'About Us' },
        }),
      ]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.success).toBe(true);
      expect(mockDuplicateBlock).toHaveBeenCalledWith('ps-123', 'col-456', 'About Us');
    });

    it('fails when duplicateBlock returns failure', async () => {
      mockDuplicateBlock.mockResolvedValue({
        success: false,
        error: 'Block not found',
      });

      const plan = makePlan([
        makeOp({
          operationType: 'duplicate_block',
          content: { duplicateBlockSearchText: 'Missing Block' },
        }),
      ]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.success).toBe(false);
      expect(result.failedOperations).toHaveLength(1);
    });
  });

  describe('duplicate_section operations', () => {
    it('duplicates a section by text search', async () => {
      mockDuplicateSection.mockResolvedValue({
        success: true,
        originalSectionId: 's1',
        newSectionId: 'new-s1',
        newSectionIndex: 1,
      });

      const plan = makePlan([
        makeOp({
          operationType: 'duplicate_section',
          content: { duplicateSectionSearch: 'Hero Section' },
        }),
      ]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.success).toBe(true);
      expect(mockDuplicateSection).toHaveBeenCalledWith('ps-123', 'col-456', 'Hero Section');
    });

    it('duplicates a section by index', async () => {
      mockDuplicateSection.mockResolvedValue({
        success: true,
        originalSectionId: 's1',
        newSectionId: 'new-s1',
        newSectionIndex: 1,
      });

      const plan = makePlan([
        makeOp({
          operationType: 'duplicate_section',
          content: { duplicateSectionSearch: 0 },
        }),
      ]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.success).toBe(true);
      expect(mockDuplicateSection).toHaveBeenCalledWith('ps-123', 'col-456', 0);
    });

    it('fails when duplicateSection returns failure', async () => {
      mockDuplicateSection.mockResolvedValue({
        success: false,
        error: 'Section not found',
      });

      const plan = makePlan([
        makeOp({
          operationType: 'duplicate_section',
          content: { duplicateSectionSearch: 'Missing Section' },
        }),
      ]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.success).toBe(false);
      expect(result.failedOperations).toHaveLength(1);
    });
  });

  describe('swap_blocks operations', () => {
    it('swaps two blocks by search text', async () => {
      mockSwapBlocks.mockResolvedValue({
        success: true,
        blockId: 'b1',
      });

      const plan = makePlan([
        makeOp({
          operationType: 'swap_blocks',
          content: {
            swapBlock1SearchText: 'About Us',
            swapBlock2SearchText: 'Our Mission',
          },
        }),
      ]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.success).toBe(true);
      expect(mockSwapBlocks).toHaveBeenCalledWith('ps-123', 'col-456', 'About Us', 'Our Mission');
    });

    it('fails when swapBlocks returns failure', async () => {
      mockSwapBlocks.mockResolvedValue({
        success: false,
        error: 'Block 2 not found',
      });

      const plan = makePlan([
        makeOp({
          operationType: 'swap_blocks',
          content: {
            swapBlock1SearchText: 'About Us',
            swapBlock2SearchText: 'Missing Block',
          },
        }),
      ]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.success).toBe(false);
      expect(result.failedOperations).toHaveLength(1);
    });
  });

  describe('summary and duration', () => {
    it('reports summary for all-success', async () => {
      mockPatchTextBlock.mockResolvedValue({ success: true });

      const plan = makePlan([makeOp({ operationType: 'modify_text', content: { bodyText: 'Test' } })]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.summary).toContain('1 operations completed via API');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('reports summary for partial failure', async () => {
      mockPatchTextBlock.mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: false, error: 'err' });

      const plan = makePlan([
        makeOp({ operationType: 'modify_text', content: { bodyText: 'A' } }),
        makeOp({ operationType: 'modify_text', content: { bodyText: 'B' } }),
      ]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.summary).toContain('1/2 operations succeeded');
      expect(result.summary).toContain('1 failed');
    });
  });

  describe('template section operations', () => {
    it('copies a template section and applies text replacements', async () => {
      mockCopyTemplateSectionFromCatalog.mockResolvedValue({
        success: true,
        sectionId: 'tmpl-section-123',
      });
      mockUpdateTextBlock.mockResolvedValue({ success: true });

      const plan = makePlan([
        makeOp({
          operationType: 'add_section',
          targetPage: 'home',
          content: {
            heading: 'Contact Us',
            contentStrategy: 'template',
            templateCategory: 'Contact',
            templateIndex: 1,
            replacements: {
              texts: [
                { searchText: 'Contact Us', newText: 'Get In Touch' },
                { searchText: 'Lorem ipsum', newText: 'We would love to hear from you.' },
              ],
            },
          },
        }),
      ]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.success).toBe(true);
      expect(result.operationResults).toHaveLength(1);
      expect(result.operationResults[0].success).toBe(true);
      expect(result.operationResults[0].summary).toContain('template section');
      expect(mockCopyTemplateSectionFromCatalog).toHaveBeenCalledWith('test-site', 'Contact', 1);
      expect(mockUpdateTextBlock).toHaveBeenCalledTimes(2);
    });

    it('copies a template section with block removals', async () => {
      mockCopyTemplateSectionFromCatalog.mockResolvedValue({
        success: true,
        sectionId: 'tmpl-section-456',
      });
      mockRemoveBlock.mockResolvedValue({ success: true });

      const plan = makePlan([
        makeOp({
          operationType: 'add_section',
          targetPage: 'home',
          content: {
            heading: 'About',
            contentStrategy: 'template',
            templateCategory: 'About',
            templateIndex: 0,
            replacements: {
              removeBlocks: ['Learn More', 'Subscribe'],
            },
          },
        }),
      ]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.success).toBe(true);
      expect(mockCopyTemplateSectionFromCatalog).toHaveBeenCalledWith('test-site', 'About', 0);
      expect(mockRemoveBlock).toHaveBeenCalledTimes(2);
    });

    it('copies a template section with button replacements', async () => {
      mockCopyTemplateSectionFromCatalog.mockResolvedValue({
        success: true,
        sectionId: 'tmpl-section-789',
      });
      mockUpdateButtonBlock.mockResolvedValue({ success: true });

      const plan = makePlan([
        makeOp({
          operationType: 'add_section',
          targetPage: 'home',
          content: {
            heading: 'Services',
            contentStrategy: 'template',
            templateCategory: 'Services',
            templateIndex: 0,
            replacements: {
              buttons: [
                { searchText: 'Learn More', newLabel: 'Book Now', url: '/book' },
              ],
            },
          },
        }),
      ]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.success).toBe(true);
      expect(mockUpdateButtonBlock).toHaveBeenCalledWith(
        'ps-123', 'col-456', 'Learn More',
        { newLabel: 'Book Now', url: '/book' },
      );
    });

    it('fails when template copy fails', async () => {
      mockCopyTemplateSectionFromCatalog.mockResolvedValue(null);

      const plan = makePlan([
        makeOp({
          operationType: 'add_section',
          targetPage: 'home',
          content: {
            heading: 'Contact',
            contentStrategy: 'template',
            templateCategory: 'Contact',
            templateIndex: 99,
          },
        }),
      ]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.success).toBe(false);
      expect(result.failedOperations).toHaveLength(1);
    });

    it('handles mixed template + blank_api plan', async () => {
      mockCopyTemplateSectionFromCatalog.mockResolvedValue({
        success: true,
        sectionId: 'tmpl-section-mix',
      });
      mockAddBlankSection.mockResolvedValue({ success: true, sectionId: 'blank-section-mix' });
      mockAddTextBlock.mockResolvedValue({ success: true, blockId: 'b1' });

      const plan = makePlan([
        makeOp({
          operationType: 'add_section',
          targetPage: 'home',
          content: {
            heading: 'About',
            contentStrategy: 'template',
            templateCategory: 'About',
            templateIndex: 0,
          },
        }),
        makeOp({
          operationType: 'add_section',
          targetPage: 'home',
          content: {
            heading: 'Custom Section',
            contentStrategy: 'blank_api',
            apiBlocks: [{ html: '<p>Custom content</p>' }],
          },
        }),
      ]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.success).toBe(true);
      expect(result.operationResults).toHaveLength(2);
      expect(mockCopyTemplateSectionFromCatalog).toHaveBeenCalledTimes(1);
      expect(mockAddBlankSection).toHaveBeenCalledTimes(1);
    });
  });
});
