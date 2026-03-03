import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock dependencies ────────────────────────────────────────────────────────

const mockCheckSessionHealth = vi.fn();
const mockPatchTextBlock = vi.fn();
const mockUpdateTextBlock = vi.fn();
const mockAddTextBlock = vi.fn();
const mockUpdateButtonBlock = vi.fn();
const mockUpdateImageBlock = vi.fn();
const mockRemoveBlock = vi.fn();
const mockGetMenuBlock = vi.fn();
const mockUpdateMenuBlock = vi.fn();
const mockPatchFooterTextBlock = vi.fn();
const mockGetCustomCSS = vi.fn();
const mockSaveCustomCSS = vi.fn();
const mockGetPageSections = vi.fn();
const mockUpdateSiteIdentity = vi.fn();

vi.mock('../content-save.js', () => ({
  ContentSaveClient: {
    checkSessionHealth: (...args: any[]) => mockCheckSessionHealth(...args),
  },
  createContentSaveClient: vi.fn(() => ({
    patchTextBlock: mockPatchTextBlock,
    updateTextBlock: mockUpdateTextBlock,
    addTextBlock: mockAddTextBlock,
    updateButtonBlock: mockUpdateButtonBlock,
    updateImageBlock: mockUpdateImageBlock,
    removeBlock: mockRemoveBlock,
    getMenuBlock: mockGetMenuBlock,
    updateMenuBlock: mockUpdateMenuBlock,
    patchFooterTextBlock: mockPatchFooterTextBlock,
    getCustomCSS: mockGetCustomCSS,
    saveCustomCSS: mockSaveCustomCSS,
    getPageSections: mockGetPageSections,
    updateSiteIdentity: mockUpdateSiteIdentity,
  })),
}));

const mockResolvePageIds = vi.fn();
vi.mock('../page-id-resolver.js', () => ({
  resolvePageIds: (...args: any[]) => mockResolvePageIds(...args),
}));

const mockMergeMenuFromText = vi.fn();
vi.mock('../menu-merger.js', () => ({
  mergeMenuFromText: (...args: any[]) => mockMergeMenuFromText(...args),
}));

// ── Import after mocks ───────────────────────────────────────────────────────

import { executeSimpleEdit } from '../simple-edit-executor.js';
import type { SimpleEditClassification, SimpleEditType } from '../simple-edit-executor.js';
import type { Task } from '../../models/task.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task-1',
    taskType: 'general_edit',
    clientName: 'Test Client',
    siteId: 'test-site',
    targetPage: 'about',
    applyToAllSites: false,
    needsClarification: false,
    status: 'confirmed',
    attemptCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeClassification(overrides?: Partial<SimpleEditClassification>): SimpleEditClassification {
  return {
    isSimpleEdit: true,
    editType: 'text_replace',
    confidence: 'high',
    params: {
      searchText: 'Old text',
      newContent: 'New text',
    },
    reason: 'Simple text replacement',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('executeSimpleEdit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckSessionHealth.mockReturnValue({ exists: true, ageHours: 1, isStale: false, hasCrumb: true });
    mockResolvePageIds.mockResolvedValue({ pageSectionsId: 'ps-123', collectionId: 'col-456' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Session health ────────────────────────────────────────────────────

  describe('session health checks', () => {
    it('fails when session does not exist', async () => {
      mockCheckSessionHealth.mockReturnValue({ exists: false, ageHours: -1, isStale: true, hasCrumb: false });

      const result = await executeSimpleEdit(makeTask(), makeClassification());

      expect(result.success).toBe(false);
      expect(result.error).toContain('exists=false');
    });

    it('fails when session has no crumb', async () => {
      mockCheckSessionHealth.mockReturnValue({ exists: true, ageHours: 1, isStale: false, hasCrumb: false });

      const result = await executeSimpleEdit(makeTask(), makeClassification());

      expect(result.success).toBe(false);
      expect(result.error).toContain('hasCrumb=false');
    });
  });

  // ── Page ID resolution ────────────────────────────────────────────────

  describe('page ID resolution', () => {
    it('fails when page IDs cannot be resolved', async () => {
      mockResolvePageIds.mockResolvedValue(null);

      const result = await executeSimpleEdit(makeTask(), makeClassification());

      expect(result.success).toBe(false);
      expect(result.error).toContain('Could not resolve page IDs');
    });

    it('skips page ID resolution for footer_edit', async () => {
      mockPatchFooterTextBlock.mockResolvedValue({ success: true });

      const result = await executeSimpleEdit(
        makeTask(),
        makeClassification({
          editType: 'footer_edit',
          params: { searchText: 'Old footer', newContent: 'New footer' },
        }),
      );

      expect(result.success).toBe(true);
      expect(mockResolvePageIds).not.toHaveBeenCalled();
    });

    it('skips page ID resolution for css_change', async () => {
      mockSaveCustomCSS.mockResolvedValue({ success: true });

      const result = await executeSimpleEdit(
        makeTask(),
        makeClassification({
          editType: 'css_change',
          params: { cssContent: 'body { color: red; }', cssMode: 'replace' },
        }),
      );

      expect(result.success).toBe(true);
      expect(mockResolvePageIds).not.toHaveBeenCalled();
    });
  });

  // ── text_replace ──────────────────────────────────────────────────────

  describe('text_replace', () => {
    it('calls patchTextBlock with correct args', async () => {
      mockPatchTextBlock.mockResolvedValue({ success: true });

      const result = await executeSimpleEdit(
        makeTask(),
        makeClassification({
          editType: 'text_replace',
          params: { searchText: 'Hello', newContent: 'World' },
        }),
      );

      expect(result.success).toBe(true);
      expect(result.editType).toBe('text_replace');
      expect(mockPatchTextBlock).toHaveBeenCalledWith('ps-123', 'col-456', 'Hello', 'World');
    });

    it('fails when patchTextBlock fails', async () => {
      mockPatchTextBlock.mockResolvedValue({ success: false, error: 'Block not found' });

      const result = await executeSimpleEdit(
        makeTask(),
        makeClassification({
          editType: 'text_replace',
          params: { searchText: 'Missing', newContent: 'New' },
        }),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Block not found');
    });

    it('fails when searchText is missing', async () => {
      const result = await executeSimpleEdit(
        makeTask(),
        makeClassification({
          editType: 'text_replace',
          params: { newContent: 'New' },
        }),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('searchText required');
    });
  });

  // ── text_add ──────────────────────────────────────────────────────────

  describe('text_add', () => {
    it('adds a text block to the last section', async () => {
      mockGetPageSections.mockResolvedValue({
        sections: [{}, {}, {}], // 3 sections
      });
      mockAddTextBlock.mockResolvedValue({ success: true });

      const result = await executeSimpleEdit(
        makeTask(),
        makeClassification({
          editType: 'text_add',
          params: { newContent: 'New paragraph' },
        }),
      );

      expect(result.success).toBe(true);
      expect(mockAddTextBlock).toHaveBeenCalledWith(
        'ps-123', 'col-456', 2,
        expect.stringContaining('New paragraph'),
      );
    });

    it('wraps plain text in paragraph tags', async () => {
      mockGetPageSections.mockResolvedValue({ sections: [{}] });
      mockAddTextBlock.mockResolvedValue({ success: true });

      await executeSimpleEdit(
        makeTask(),
        makeClassification({
          editType: 'text_add',
          params: { newContent: 'Plain text' },
        }),
      );

      expect(mockAddTextBlock).toHaveBeenCalledWith(
        'ps-123', 'col-456', 0,
        '<p class="" style="white-space:pre-wrap;">Plain text</p>',
      );
    });

    it('passes through HTML content as-is', async () => {
      mockGetPageSections.mockResolvedValue({ sections: [{}] });
      mockAddTextBlock.mockResolvedValue({ success: true });

      await executeSimpleEdit(
        makeTask(),
        makeClassification({
          editType: 'text_add',
          params: { newContent: '<h2>Heading</h2><p>Paragraph</p>' },
        }),
      );

      expect(mockAddTextBlock).toHaveBeenCalledWith(
        'ps-123', 'col-456', 0,
        '<h2>Heading</h2><p>Paragraph</p>',
      );
    });
  });

  // ── button_edit ───────────────────────────────────────────────────────

  describe('button_edit', () => {
    it('updates button label and URL', async () => {
      mockUpdateButtonBlock.mockResolvedValue({ success: true });

      const result = await executeSimpleEdit(
        makeTask(),
        makeClassification({
          editType: 'button_edit',
          params: { searchText: 'Click Me', buttonLabel: 'Click Me', buttonUrl: '/new-page' },
        }),
      );

      expect(result.success).toBe(true);
      expect(mockUpdateButtonBlock).toHaveBeenCalledWith(
        'ps-123', 'col-456', 'Click Me',
        expect.objectContaining({ url: '/new-page' }),
      );
    });

    it('fails when no search text or label provided', async () => {
      const result = await executeSimpleEdit(
        makeTask(),
        makeClassification({
          editType: 'button_edit',
          params: { buttonUrl: '/page' },
        }),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('searchText or buttonLabel required');
    });
  });

  // ── image_metadata ────────────────────────────────────────────────────

  describe('image_metadata', () => {
    it('updates image fields', async () => {
      mockUpdateImageBlock.mockResolvedValue({ success: true });

      const result = await executeSimpleEdit(
        makeTask(),
        makeClassification({
          editType: 'image_metadata',
          params: {
            searchText: 'Hero image',
            imageFields: { altText: 'Updated alt text', title: 'New title' },
          },
        }),
      );

      expect(result.success).toBe(true);
      expect(mockUpdateImageBlock).toHaveBeenCalledWith(
        'ps-123', 'col-456', 'Hero image',
        { altText: 'Updated alt text', title: 'New title' },
      );
    });

    it('fails when imageFields is missing', async () => {
      const result = await executeSimpleEdit(
        makeTask(),
        makeClassification({
          editType: 'image_metadata',
          params: { searchText: 'Some image' },
        }),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('imageFields required');
    });
  });

  // ── block_remove ──────────────────────────────────────────────────────

  describe('block_remove', () => {
    it('removes a block by search text', async () => {
      mockRemoveBlock.mockResolvedValue({ success: true });

      const result = await executeSimpleEdit(
        makeTask(),
        makeClassification({
          editType: 'block_remove',
          params: { searchText: 'Delete me' },
        }),
      );

      expect(result.success).toBe(true);
      expect(mockRemoveBlock).toHaveBeenCalledWith('ps-123', 'col-456', 'Delete me');
    });
  });

  // ── menu_update ───────────────────────────────────────────────────────

  describe('menu_update', () => {
    it('merges menu items and updates', async () => {
      const currentMenus = [{ title: 'Lunch', sections: [] }];
      const mergedMenus = [{ title: 'Lunch', sections: [{ title: 'New Section', items: [] }] }];

      mockGetMenuBlock.mockResolvedValue({ success: true, menus: currentMenus });
      mockMergeMenuFromText.mockReturnValue(mergedMenus);
      mockUpdateMenuBlock.mockResolvedValue({ success: true });

      const result = await executeSimpleEdit(
        makeTask(),
        makeClassification({
          editType: 'menu_update',
          params: { searchText: 'Lunch', menuItems: 'New Section\n-------\nNew Item $10' },
        }),
      );

      expect(result.success).toBe(true);
      expect(mockMergeMenuFromText).toHaveBeenCalledWith(currentMenus, 'New Section\n-------\nNew Item $10');
      expect(mockUpdateMenuBlock).toHaveBeenCalledWith(
        'ps-123', 'col-456', 'Lunch', mergedMenus,
      );
    });

    it('fails when getMenuBlock fails', async () => {
      mockGetMenuBlock.mockResolvedValue({ success: false, error: 'Menu not found' });

      const result = await executeSimpleEdit(
        makeTask(),
        makeClassification({
          editType: 'menu_update',
          params: { searchText: 'Lunch', menuItems: 'New item $10' },
        }),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Menu not found');
    });
  });

  // ── footer_edit ───────────────────────────────────────────────────────

  describe('footer_edit', () => {
    it('patches footer text block', async () => {
      mockPatchFooterTextBlock.mockResolvedValue({ success: true });

      const result = await executeSimpleEdit(
        makeTask(),
        makeClassification({
          editType: 'footer_edit',
          params: { searchText: '2025', newContent: '2026' },
        }),
      );

      expect(result.success).toBe(true);
      expect(mockPatchFooterTextBlock).toHaveBeenCalledWith('2025', '2026');
    });
  });

  // ── css_change ────────────────────────────────────────────────────────

  describe('css_change', () => {
    it('replaces custom CSS', async () => {
      mockSaveCustomCSS.mockResolvedValue({ success: true });

      const result = await executeSimpleEdit(
        makeTask(),
        makeClassification({
          editType: 'css_change',
          params: { cssContent: 'body { color: red; }', cssMode: 'replace' },
        }),
      );

      expect(result.success).toBe(true);
      expect(mockSaveCustomCSS).toHaveBeenCalledWith('body { color: red; }');
    });

    it('appends to existing CSS', async () => {
      mockGetCustomCSS.mockResolvedValue({ success: true, css: '/* existing */' });
      mockSaveCustomCSS.mockResolvedValue({ success: true });

      const result = await executeSimpleEdit(
        makeTask(),
        makeClassification({
          editType: 'css_change',
          params: { cssContent: '.new { display: block; }', cssMode: 'append' },
        }),
      );

      expect(result.success).toBe(true);
      expect(mockSaveCustomCSS).toHaveBeenCalledWith('/* existing */\n\n.new { display: block; }');
    });

    it('handles append when no existing CSS', async () => {
      mockGetCustomCSS.mockResolvedValue({ success: true, css: '' });
      mockSaveCustomCSS.mockResolvedValue({ success: true });

      const result = await executeSimpleEdit(
        makeTask(),
        makeClassification({
          editType: 'css_change',
          params: { cssContent: '.new { display: block; }', cssMode: 'append' },
        }),
      );

      expect(result.success).toBe(true);
      expect(mockSaveCustomCSS).toHaveBeenCalledWith('.new { display: block; }');
    });
  });

  // ── site_identity ─────────────────────────────────────────────────────

  describe('site_identity', () => {
    it('skips page ID resolution for site_identity', async () => {
      mockUpdateSiteIdentity.mockResolvedValue({ success: true, updatedFields: ['businessName'] });

      const result = await executeSimpleEdit(
        makeTask(),
        makeClassification({
          editType: 'site_identity',
          params: { businessName: 'Acme Corp' },
        }),
      );

      expect(result.success).toBe(true);
      expect(mockResolvePageIds).not.toHaveBeenCalled();
    });

    it('maps businessName to updateSiteIdentity', async () => {
      mockUpdateSiteIdentity.mockResolvedValue({ success: true, updatedFields: ['businessName'] });

      const result = await executeSimpleEdit(
        makeTask(),
        makeClassification({
          editType: 'site_identity',
          params: { businessName: 'Acme Corp' },
        }),
      );

      expect(result.success).toBe(true);
      expect(mockUpdateSiteIdentity).toHaveBeenCalledWith(
        expect.objectContaining({ businessName: 'Acme Corp' }),
      );
    });

    it('maps businessAddress to updateSiteIdentity address field', async () => {
      mockUpdateSiteIdentity.mockResolvedValue({ success: true, updatedFields: ['address'] });

      const result = await executeSimpleEdit(
        makeTask(),
        makeClassification({
          editType: 'site_identity',
          params: { businessAddress: '123 Main St' },
        }),
      );

      expect(result.success).toBe(true);
      expect(mockUpdateSiteIdentity).toHaveBeenCalledWith(
        expect.objectContaining({ address: '123 Main St' }),
      );
    });

    it('maps businessPhone to updateSiteIdentity phone field', async () => {
      mockUpdateSiteIdentity.mockResolvedValue({ success: true, updatedFields: ['phone'] });

      const result = await executeSimpleEdit(
        makeTask(),
        makeClassification({
          editType: 'site_identity',
          params: { businessPhone: '555-1234' },
        }),
      );

      expect(result.success).toBe(true);
      expect(mockUpdateSiteIdentity).toHaveBeenCalledWith(
        expect.objectContaining({ phone: '555-1234' }),
      );
    });

    it('maps businessEmail to updateSiteIdentity email field', async () => {
      mockUpdateSiteIdentity.mockResolvedValue({ success: true, updatedFields: ['email'] });

      const result = await executeSimpleEdit(
        makeTask(),
        makeClassification({
          editType: 'site_identity',
          params: { businessEmail: 'hello@acme.com' },
        }),
      );

      expect(result.success).toBe(true);
      expect(mockUpdateSiteIdentity).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'hello@acme.com' }),
      );
    });

    it('passes multiple fields in a single updateSiteIdentity call', async () => {
      mockUpdateSiteIdentity.mockResolvedValue({ success: true, updatedFields: ['businessName', 'phone'] });

      const result = await executeSimpleEdit(
        makeTask(),
        makeClassification({
          editType: 'site_identity',
          params: { businessName: 'New Name', businessPhone: '555-9999' },
        }),
      );

      expect(result.success).toBe(true);
      expect(mockUpdateSiteIdentity).toHaveBeenCalledWith({
        businessName: 'New Name',
        phone: '555-9999',
      });
    });

    it('fails when no site identity fields are provided', async () => {
      const result = await executeSimpleEdit(
        makeTask(),
        makeClassification({
          editType: 'site_identity',
          params: {},
        }),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('No site identity fields to update');
    });

    it('fails when updateSiteIdentity returns failure', async () => {
      mockUpdateSiteIdentity.mockResolvedValue({ success: false, error: 'API error' });

      const result = await executeSimpleEdit(
        makeTask(),
        makeClassification({
          editType: 'site_identity',
          params: { businessName: 'Acme Corp' },
        }),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('API error');
    });
  });

  // ── Timing ────────────────────────────────────────────────────────────

  describe('timing', () => {
    it('includes durationMs in result', async () => {
      mockPatchTextBlock.mockResolvedValue({ success: true });

      const result = await executeSimpleEdit(makeTask(), makeClassification());

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.durationMs).toBe('number');
    });

    it('includes durationMs even on failure', async () => {
      mockCheckSessionHealth.mockReturnValue({ exists: false, ageHours: -1, isStale: true, hasCrumb: false });

      const result = await executeSimpleEdit(makeTask(), makeClassification());

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Error handling ────────────────────────────────────────────────────

  describe('error handling', () => {
    it('catches thrown errors gracefully', async () => {
      mockPatchTextBlock.mockRejectedValue(new Error('Network timeout'));

      const result = await executeSimpleEdit(makeTask(), makeClassification());

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network timeout');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('handles non-Error throws', async () => {
      mockPatchTextBlock.mockRejectedValue('string error');

      const result = await executeSimpleEdit(makeTask(), makeClassification());

      expect(result.success).toBe(false);
      expect(result.error).toBe('string error');
    });
  });

  // ── Slug normalization ────────────────────────────────────────────────

  describe('slug normalization', () => {
    it('normalizes homepage to home', async () => {
      mockPatchTextBlock.mockResolvedValue({ success: true });

      await executeSimpleEdit(
        makeTask({ targetPage: 'homepage' }),
        makeClassification(),
      );

      expect(mockResolvePageIds).toHaveBeenCalledWith('test-site', 'home');
    });

    it('defaults missing targetPage to home', async () => {
      mockPatchTextBlock.mockResolvedValue({ success: true });

      await executeSimpleEdit(
        makeTask({ targetPage: undefined }),
        makeClassification(),
      );

      expect(mockResolvePageIds).toHaveBeenCalledWith('test-site', 'home');
    });
  });
});
