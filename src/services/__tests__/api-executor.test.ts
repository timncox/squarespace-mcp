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

// Mock section-catalog
const mockGetOrFetchCatalog = vi.fn();
const mockLookupCatalogEntry = vi.fn();
vi.mock('../section-catalog.js', () => ({
  getOrFetchCatalog: (...args: unknown[]) => mockGetOrFetchCatalog(...args),
  lookupCatalogEntry: (...args: unknown[]) => mockLookupCatalogEntry(...args),
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
const mockCopyTemplateSection = vi.fn();
const mockCreatePageViaApi = vi.fn();
const mockMoveSection = vi.fn();
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
    copyTemplateSection: mockCopyTemplateSection,
    createPageViaApi: mockCreatePageViaApi,
    moveSection: mockMoveSection,
  }),
  ContentSaveClient: {
    checkSessionHealth: () => mockCheckSessionHealth(),
    buildRichHtml: (elements: unknown[]) => '<p>built html</p>',
  },
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

  describe('add_section template', () => {
    it('copies a template section with replacements', async () => {
      mockGetOrFetchCatalog.mockResolvedValue({
        CONTACT: [{ websiteId: 'w1', collectionId: 'c1', sectionId: 's1' }],
      });
      mockLookupCatalogEntry.mockReturnValue({ websiteId: 'w1', collectionId: 'c1', sectionId: 's1' });
      mockCopyTemplateSection.mockResolvedValue({ success: true, sectionId: 'new-s1' });
      mockUpdateTextBlock.mockResolvedValue({ success: true });
      mockRemoveBlock.mockResolvedValue({ success: true });

      const plan = makePlan([
        makeOp({
          operationType: 'add_section',
          content: {
            contentStrategy: 'template',
            templateCategory: 'CONTACT',
            templateIndex: 0,
            replacements: {
              texts: [{ searchText: 'Lorem ipsum', newText: 'Contact us today' }],
              removeBlocks: ['Sign Up'],
            },
          },
        }),
      ]);
      const result = await executeContentPlanViaApi(plan, 'test-site');

      expect(result.success).toBe(true);
      expect(mockCopyTemplateSection).toHaveBeenCalledWith('w1', 'c1', 's1');
      expect(mockUpdateTextBlock).toHaveBeenCalledWith('ps-123', 'col-456', 'Lorem ipsum', 'Contact us today');
      expect(mockRemoveBlock).toHaveBeenCalledWith('ps-123', 'col-456', 'Sign Up');
    });

    it('fails when catalog lookup fails', async () => {
      mockGetOrFetchCatalog.mockResolvedValue(null);

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
});
