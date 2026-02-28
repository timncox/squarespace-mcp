import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task } from '../../models/task.js';
import type { SimpleEditClassification } from '../simple-edit-classifier.js';

const mockCreateBlogPost = vi.fn();
const mockGetCollectionItems = vi.fn();
const mockUpdateBlogPost = vi.fn();
const mockGetPageMetadata = vi.fn();
const mockFindBlogPostByTitle = vi.fn();

vi.mock('../content-save.js', () => ({
  createContentSaveClient: vi.fn(() => ({
    createBlogPost: mockCreateBlogPost,
    getCollectionItems: mockGetCollectionItems,
    updateBlogPost: mockUpdateBlogPost,
    getPageMetadata: mockGetPageMetadata,
    findBlogPostByTitle: mockFindBlogPostByTitle,
    loadCookies: vi.fn().mockResolvedValue(undefined),
  })),
  ContentSaveClient: {
    checkSessionHealth: vi.fn().mockReturnValue({ exists: true, hasCrumb: true, isStale: false }),
  },
}));

// Mock page ID resolver — returns blog collection ID as collectionId
vi.mock('../page-id-resolver.js', () => ({
  resolvePageIds: vi.fn().mockResolvedValue({ pageSectionsId: 'ps-abc', collectionId: 'col-abc' }),
}));

const { executeSimpleEdit } = await import('../simple-edit-executor.js');

const baseTask = {
  id: 1,
  siteId: 'test-site',
  targetPage: 'blog',
  description: 'test task',
  status: 'pending',
} as unknown as Task;

// ─── blog_post_create ───────────────────────────────────────────────────────

describe('executeSimpleEdit — blog_post_create', () => {
  beforeEach(() => {
    mockCreateBlogPost.mockReset();
  });

  it('creates a draft blog post with title and body', async () => {
    mockCreateBlogPost.mockResolvedValue({ success: true, itemId: 'item-1', endpointAvailable: true });

    const classification: SimpleEditClassification = {
      isSimpleEdit: true,
      editType: 'blog_post_create',
      confidence: 'high',
      params: { postTitle: 'My New Post', postBody: '<p>Hello world</p>', postDraft: true },
      reason: '',
    };

    const result = await executeSimpleEdit(baseTask, classification);

    expect(result.success).toBe(true);
    expect(result.summary).toContain('My New Post');
    expect(mockCreateBlogPost).toHaveBeenCalledWith('col-abc', 'My New Post', {
      body: '<p>Hello world</p>',
      excerpt: undefined,
      tags: undefined,
      categories: undefined,
      draft: true,
    });
  });

  it('returns failure when postTitle is missing', async () => {
    const classification: SimpleEditClassification = {
      isSimpleEdit: true,
      editType: 'blog_post_create',
      confidence: 'high',
      params: {},
      reason: '',
    };

    const result = await executeSimpleEdit(baseTask, classification);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/postTitle required/i);
  });

  it('returns failure when API endpoint not available', async () => {
    mockCreateBlogPost.mockResolvedValue({
      success: false,
      endpointAvailable: false,
      error: 'Endpoint returned 404',
    });

    const classification: SimpleEditClassification = {
      isSimpleEdit: true,
      editType: 'blog_post_create',
      confidence: 'high',
      params: { postTitle: 'Test' },
      reason: '',
    };

    const result = await executeSimpleEdit(baseTask, classification);
    expect(result.success).toBe(false);
  });
});

// ─── blog_post_update ───────────────────────────────────────────────────────

describe('executeSimpleEdit — blog_post_update', () => {
  beforeEach(() => {
    mockFindBlogPostByTitle.mockReset();
    mockUpdateBlogPost.mockReset();
  });

  it('finds post by search title and updates requested fields', async () => {
    mockFindBlogPostByTitle.mockResolvedValue({ id: 'item-1', title: 'My Old Post' });
    mockUpdateBlogPost.mockResolvedValue({ success: true, itemId: 'item-1', updatedFields: ['title', 'body'] });

    const classification: SimpleEditClassification = {
      isSimpleEdit: true,
      editType: 'blog_post_update',
      confidence: 'high',
      params: {
        postSearchTitle: 'My Old Post',
        postTitle: 'My Updated Post',
        postBody: '<p>New content</p>',
      },
      reason: '',
    };

    const result = await executeSimpleEdit(baseTask, classification);
    expect(result.success).toBe(true);
    expect(mockUpdateBlogPost).toHaveBeenCalledWith('col-abc', 'item-1', {
      title: 'My Updated Post',
      body: '<p>New content</p>',
      excerpt: undefined,
      tags: undefined,
      categories: undefined,
      draft: undefined,
    });
  });

  it('returns failure when postSearchTitle is missing', async () => {
    const classification: SimpleEditClassification = {
      isSimpleEdit: true,
      editType: 'blog_post_update',
      confidence: 'high',
      params: { postTitle: 'New Title' },
      reason: '',
    };

    const result = await executeSimpleEdit(baseTask, classification);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/postSearchTitle required/i);
  });

  it('returns failure when no matching post found', async () => {
    mockFindBlogPostByTitle.mockResolvedValue(null);

    const classification: SimpleEditClassification = {
      isSimpleEdit: true,
      editType: 'blog_post_update',
      confidence: 'high',
      params: { postSearchTitle: 'Nonexistent Post' },
      reason: '',
    };

    const result = await executeSimpleEdit(baseTask, classification);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });
});
