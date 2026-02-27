import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task } from '../../models/task.js';
import type { PageStructure } from '../../agents/types.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCreate = vi.fn();

vi.mock('../../utils/anthropic-client.js', () => ({
  getAnthropicClient: () => ({
    messages: { create: mockCreate },
  }),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// ─── Import after mocks ────────────────────────────────────────────────────

import { classifySimpleEdit } from '../simple-edit-classifier.js';
import type { SimpleEditClassification } from '../simple-edit-classifier.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test-1',
    taskType: 'general_edit',
    clientName: 'Test Client',
    siteId: 'test-site',
    applyToAllSites: false,
    needsClarification: false,
    status: 'pending',
    attemptCount: 0,
    createdAt: '2026-02-27T00:00:00Z',
    updatedAt: '2026-02-27T00:00:00Z',
    ...overrides,
  };
}

function mockLlmResponse(json: Record<string, unknown>): void {
  mockCreate.mockResolvedValueOnce({
    content: [{ type: 'text', text: JSON.stringify(json) }],
  });
}

function mockLlmResponseMarkdown(json: Record<string, unknown>): void {
  mockCreate.mockResolvedValueOnce({
    content: [{ type: 'text', text: '```json\n' + JSON.stringify(json) + '\n```' }],
  });
}

const samplePageStructure: PageStructure = {
  sectionCount: 2,
  sections: [
    {
      id: 'sec-1',
      index: 0,
      name: 'Hero',
      blockCount: 2,
      blocks: [
        { type: 'text', textSnippet: 'Welcome to our restaurant' },
        { type: 'button', buttonLabel: 'Book Now', buttonUrl: '/reservations' },
      ],
    },
    {
      id: 'sec-2',
      index: 1,
      name: 'About',
      blockCount: 1,
      blocks: [
        { type: 'text', textSnippet: 'We serve the finest Italian cuisine since 1985' },
      ],
    },
  ],
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('classifySimpleEdit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Pre-LLM Fast Checks ────────────────────────────────────────────────

  describe('pre-LLM fast checks', () => {
    it('classifies remove_content + contentToFind as block_remove', async () => {
      const task = makeTask({
        taskType: 'remove_content',
        contentToFind: 'Happy Hour Special',
      });

      const result = await classifySimpleEdit(task);

      expect(result.isSimpleEdit).toBe(true);
      expect(result.editType).toBe('block_remove');
      expect(result.confidence).toBe('high');
      expect(result.params.searchText).toBe('Happy Hour Special');
      expect(mockCreate).not.toHaveBeenCalled(); // No LLM call
    });

    it('classifies contentToFind + contentToAdd as text_replace', async () => {
      const task = makeTask({
        contentToFind: '555-1234',
        contentToAdd: '555-5678',
      });

      const result = await classifySimpleEdit(task);

      expect(result.isSimpleEdit).toBe(true);
      expect(result.editType).toBe('text_replace');
      expect(result.confidence).toBe('high');
      expect(result.params.searchText).toBe('555-1234');
      expect(result.params.newContent).toBe('555-5678');
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('classifies update_menu_block + contentToAdd as menu_update', async () => {
      const task = makeTask({
        taskType: 'update_menu_block',
        contentToAdd: 'Tiramisu $12\nPanna Cotta $10',
      });

      const result = await classifySimpleEdit(task);

      expect(result.isSimpleEdit).toBe(true);
      expect(result.editType).toBe('menu_update');
      expect(result.confidence).toBe('high');
      expect(result.params.menuItems).toBe('Tiramisu $12\nPanna Cotta $10');
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('prefers remove_content over contentToFind+contentToAdd', async () => {
      // remove_content check runs first
      const task = makeTask({
        taskType: 'remove_content',
        contentToFind: 'Old special',
        contentToAdd: 'this should be ignored',
      });

      const result = await classifySimpleEdit(task);

      expect(result.editType).toBe('block_remove');
    });
  });

  // ── Complexity Gate ────────────────────────────────────────────────────

  describe('complexity gate', () => {
    it('rejects tasks with referenceImagePath', async () => {
      const task = makeTask({
        description: 'Change the text shown in this screenshot',
        referenceImagePath: '/storage/uploads/screenshot.png',
      });

      const result = await classifySimpleEdit(task);

      expect(result.isSimpleEdit).toBe(false);
      expect(result.confidence).toBe('high');
      expect(result.reason).toContain('reference image');
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('rejects tasks with imagePaths', async () => {
      const task = makeTask({
        description: 'Add these photos',
        imagePaths: ['/storage/uploads/photo1.jpg', '/storage/uploads/photo2.jpg'],
      });

      const result = await classifySimpleEdit(task);

      expect(result.isSimpleEdit).toBe(false);
      expect(result.reason).toContain('attached images');
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('rejects page creation requests', async () => {
      const task = makeTask({
        description: 'Create a new page for our catering menu',
      });

      const result = await classifySimpleEdit(task);

      expect(result.isSimpleEdit).toBe(false);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('rejects gallery requests', async () => {
      const task = makeTask({
        description: 'Add a gallery of our restaurant photos',
      });

      const result = await classifySimpleEdit(task);

      expect(result.isSimpleEdit).toBe(false);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('rejects section addition requests', async () => {
      const task = makeTask({
        description: 'Add a section about our team',
      });

      const result = await classifySimpleEdit(task);

      expect(result.isSimpleEdit).toBe(false);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('rejects creative content requests (come up with)', async () => {
      const task = makeTask({
        description: 'Come up with a tagline for our restaurant',
      });

      const result = await classifySimpleEdit(task);

      expect(result.isSimpleEdit).toBe(false);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('rejects creative content requests (suggest)', async () => {
      const task = makeTask({
        description: 'Suggest some text for the about page',
      });

      const result = await classifySimpleEdit(task);

      expect(result.isSimpleEdit).toBe(false);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('rejects template requests', async () => {
      const task = makeTask({
        description: 'Use the team template on the about page',
      });

      const result = await classifySimpleEdit(task);

      expect(result.isSimpleEdit).toBe(false);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('rejects layout requests', async () => {
      const task = makeTask({
        description: 'Change the layout of the services section',
      });

      const result = await classifySimpleEdit(task);

      expect(result.isSimpleEdit).toBe(false);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('rejects design change requests', async () => {
      const task = makeTask({
        description: 'Design a new hero section',
      });

      const result = await classifySimpleEdit(task);

      expect(result.isSimpleEdit).toBe(false);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('rejects research-based requests', async () => {
      const task = makeTask({
        description: 'Research our competitors and update the homepage',
      });

      const result = await classifySimpleEdit(task);

      expect(result.isSimpleEdit).toBe(false);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('rejects build requests', async () => {
      const task = makeTask({
        description: 'Build out the contact page',
      });

      const result = await classifySimpleEdit(task);

      expect(result.isSimpleEdit).toBe(false);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('rejects write requests', async () => {
      const task = makeTask({
        description: 'Write an about section for the homepage',
      });

      const result = await classifySimpleEdit(task);

      expect(result.isSimpleEdit).toBe(false);
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  // ── Empty / Missing Description ────────────────────────────────────────

  describe('edge cases', () => {
    it('returns not-simple for empty description', async () => {
      const task = makeTask({ description: '' });

      const result = await classifySimpleEdit(task);

      expect(result.isSimpleEdit).toBe(false);
      expect(result.confidence).toBe('low');
      expect(result.reason).toContain('No task description');
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('returns not-simple for undefined description', async () => {
      const task = makeTask({ description: undefined });

      const result = await classifySimpleEdit(task);

      expect(result.isSimpleEdit).toBe(false);
      expect(result.confidence).toBe('low');
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('returns not-simple for whitespace-only description', async () => {
      const task = makeTask({ description: '   \n  ' });

      const result = await classifySimpleEdit(task);

      expect(result.isSimpleEdit).toBe(false);
      expect(result.confidence).toBe('low');
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  // ── LLM Classification ────────────────────────────────────────────────

  describe('LLM classification', () => {
    it('classifies text_replace via LLM', async () => {
      const task = makeTask({
        description: 'Change the phone number on the contact page to 555-9999',
        targetPage: 'contact',
      });

      mockLlmResponse({
        isSimpleEdit: true,
        editType: 'text_replace',
        confidence: 'high',
        params: { searchText: '555-1234', newContent: '555-9999' },
        reason: 'Simple phone number replacement',
      });

      const result = await classifySimpleEdit(task);

      expect(result.isSimpleEdit).toBe(true);
      expect(result.editType).toBe('text_replace');
      expect(result.confidence).toBe('high');
      expect(result.params.searchText).toBe('555-1234');
      expect(result.params.newContent).toBe('555-9999');
      expect(mockCreate).toHaveBeenCalledOnce();
    });

    it('classifies button_edit via LLM', async () => {
      const task = makeTask({
        description: 'Change the Book Now button to link to our new OpenTable page',
      });

      mockLlmResponse({
        isSimpleEdit: true,
        editType: 'button_edit',
        confidence: 'high',
        params: { buttonLabel: 'Book Now', buttonUrl: 'https://opentable.com/our-restaurant' },
        reason: 'Button URL change',
      });

      const result = await classifySimpleEdit(task);

      expect(result.isSimpleEdit).toBe(true);
      expect(result.editType).toBe('button_edit');
      expect(result.params.buttonLabel).toBe('Book Now');
      expect(result.params.buttonUrl).toBe('https://opentable.com/our-restaurant');
    });

    it('classifies footer_edit via LLM', async () => {
      const task = makeTask({
        description: 'Update the footer address to 456 Oak Avenue',
      });

      mockLlmResponse({
        isSimpleEdit: true,
        editType: 'footer_edit',
        confidence: 'medium',
        params: { searchText: '123 Main St', newContent: '456 Oak Avenue' },
        reason: 'Footer text replacement',
      });

      const result = await classifySimpleEdit(task);

      expect(result.isSimpleEdit).toBe(true);
      expect(result.editType).toBe('footer_edit');
      expect(result.confidence).toBe('medium');
    });

    it('classifies css_change via LLM', async () => {
      const task = makeTask({
        description: 'Add custom CSS to make the header font size 24px',
      });

      mockLlmResponse({
        isSimpleEdit: true,
        editType: 'css_change',
        confidence: 'high',
        params: { cssContent: 'header h1 { font-size: 24px; }', cssMode: 'append' },
        reason: 'Simple CSS addition',
      });

      const result = await classifySimpleEdit(task);

      expect(result.isSimpleEdit).toBe(true);
      expect(result.editType).toBe('css_change');
      expect(result.params.cssContent).toBe('header h1 { font-size: 24px; }');
      expect(result.params.cssMode).toBe('append');
    });

    it('classifies image_metadata via LLM', async () => {
      const task = makeTask({
        description: 'Update the hero image alt text to "Italian restaurant dining room"',
      });

      mockLlmResponse({
        isSimpleEdit: true,
        editType: 'image_metadata',
        confidence: 'high',
        params: {
          searchText: 'hero',
          imageFields: { altText: 'Italian restaurant dining room' },
        },
        reason: 'Image alt text update',
      });

      const result = await classifySimpleEdit(task);

      expect(result.isSimpleEdit).toBe(true);
      expect(result.editType).toBe('image_metadata');
      expect(result.params.imageFields?.altText).toBe('Italian restaurant dining room');
    });

    it('classifies text_add via LLM', async () => {
      const task = makeTask({
        description: 'Add "Now open Sundays!" below the opening hours',
      });

      mockLlmResponse({
        isSimpleEdit: true,
        editType: 'text_add',
        confidence: 'medium',
        params: { searchText: 'opening hours', newContent: 'Now open Sundays!' },
        reason: 'Adding text near existing content',
      });

      const result = await classifySimpleEdit(task);

      expect(result.isSimpleEdit).toBe(true);
      expect(result.editType).toBe('text_add');
    });

    it('LLM says not-simple for vague request', async () => {
      const task = makeTask({
        description: 'Make the homepage look better',
      });

      mockLlmResponse({
        isSimpleEdit: false,
        confidence: 'high',
        params: {},
        reason: 'Vague request with no specific edit target',
      });

      const result = await classifySimpleEdit(task);

      expect(result.isSimpleEdit).toBe(false);
      expect(result.reason).toContain('Vague');
    });

    it('passes page structure to LLM when available', async () => {
      const task = makeTask({
        description: 'Change the welcome text on the homepage',
      });

      mockLlmResponse({
        isSimpleEdit: true,
        editType: 'text_replace',
        confidence: 'high',
        params: { searchText: 'Welcome to our restaurant', newContent: 'Welcome to La Trattoria' },
        reason: 'Text replacement identified from page structure',
      });

      await classifySimpleEdit(task, samplePageStructure);

      // Verify the LLM call includes page structure context
      const callArgs = mockCreate.mock.calls[0][0];
      const userContent = callArgs.messages[0].content as string;
      expect(userContent).toContain('Page Structure');
      expect(userContent).toContain('Welcome to our restaurant');
      expect(userContent).toContain('Hero');
    });

    it('handles LLM response in markdown code block', async () => {
      const task = makeTask({
        description: 'Change opening time to 11am',
      });

      mockLlmResponseMarkdown({
        isSimpleEdit: true,
        editType: 'text_replace',
        confidence: 'medium',
        params: { searchText: '10am', newContent: '11am' },
        reason: 'Time replacement',
      });

      const result = await classifySimpleEdit(task);

      expect(result.isSimpleEdit).toBe(true);
      expect(result.editType).toBe('text_replace');
    });
  });

  // ── Error Handling ────────────────────────────────────────────────────

  describe('error handling', () => {
    it('returns not-simple when LLM returns invalid JSON', async () => {
      const task = makeTask({
        description: 'Update the phone number',
      });

      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'This is not valid JSON at all' }],
      });

      const result = await classifySimpleEdit(task);

      expect(result.isSimpleEdit).toBe(false);
      expect(result.confidence).toBe('low');
      expect(result.reason).toContain('Classification failed');
    });

    it('returns not-simple when LLM call throws', async () => {
      const task = makeTask({
        description: 'Update the phone number',
      });

      mockCreate.mockRejectedValueOnce(new Error('API rate limit exceeded'));

      const result = await classifySimpleEdit(task);

      expect(result.isSimpleEdit).toBe(false);
      expect(result.confidence).toBe('low');
      expect(result.reason).toContain('API rate limit exceeded');
    });

    it('returns not-simple when LLM returns empty content', async () => {
      const task = makeTask({
        description: 'Update the phone number',
      });

      mockCreate.mockResolvedValueOnce({
        content: [],
      });

      const result = await classifySimpleEdit(task);

      expect(result.isSimpleEdit).toBe(false);
      expect(result.confidence).toBe('low');
    });

    it('handles LLM response missing fields gracefully', async () => {
      const task = makeTask({
        description: 'Do something simple',
      });

      mockLlmResponse({
        isSimpleEdit: true,
        // missing editType, confidence, params, reason
      });

      const result = await classifySimpleEdit(task);

      expect(result.isSimpleEdit).toBe(true);
      expect(result.editType).toBeUndefined();
      expect(result.confidence).toBe('low');
      expect(result.params).toEqual({});
    });
  });

  // ── LLM Call Verification ─────────────────────────────────────────────

  describe('LLM call parameters', () => {
    it('uses MODEL_HAIKU', async () => {
      const task = makeTask({ description: 'Change phone number' });

      mockLlmResponse({
        isSimpleEdit: true,
        editType: 'text_replace',
        confidence: 'high',
        params: {},
        reason: 'test',
      });

      await classifySimpleEdit(task);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
        }),
      );
    });

    it('includes task type in user message', async () => {
      const task = makeTask({
        taskType: 'general_edit',
        description: 'Fix the phone number',
      });

      mockLlmResponse({
        isSimpleEdit: true,
        editType: 'text_replace',
        confidence: 'high',
        params: {},
        reason: 'test',
      });

      await classifySimpleEdit(task);

      const userContent = mockCreate.mock.calls[0][0].messages[0].content as string;
      expect(userContent).toContain('general_edit');
      expect(userContent).toContain('Fix the phone number');
    });

    it('includes contentToFind and contentToAdd in user message when present (via LLM path)', async () => {
      // Use a task that doesn't trigger pre-LLM checks but has these fields
      // contentToFind without contentToAdd won't trigger pre-LLM text_replace
      const task = makeTask({
        description: 'Update the specials with these new items',
        contentToFind: 'Summer Special',
        // no contentToAdd — so pre-LLM check doesn't fire
      });

      mockLlmResponse({
        isSimpleEdit: true,
        editType: 'text_replace',
        confidence: 'medium',
        params: { searchText: 'Summer Special' },
        reason: 'test',
      });

      await classifySimpleEdit(task);

      const userContent = mockCreate.mock.calls[0][0].messages[0].content as string;
      expect(userContent).toContain('Summer Special');
    });
  });
});
