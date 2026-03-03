import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseBrowserFallbacks, logBrowserFallback, getUnresolvedFallbacks, resolveFallback } from '../fallback-tracker.js';

// Mock database
const mockPrepare = vi.fn();
const mockExec = vi.fn();
const mockDb = {
  prepare: mockPrepare,
  exec: mockExec,
};

vi.mock('../../db/database.js', () => ({
  getDb: () => mockDb,
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('fallback-tracker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('parseBrowserFallbacks', () => {
    it('should parse structured BROWSER_FALLBACK JSON', () => {
      const output = `I updated the text block successfully.
BROWSER_FALLBACK: {"intent": "change form email", "actions": ["clicked form", "opened settings"], "reason": "no API tool for forms"}
Done.`;

      const fallbacks = parseBrowserFallbacks(output);
      expect(fallbacks).toHaveLength(1);
      expect(fallbacks[0].intent).toBe('change form email');
      expect(fallbacks[0].actions).toEqual(['clicked form', 'opened settings']);
      expect(fallbacks[0].reason).toBe('no API tool for forms');
    });

    it('should parse multiple fallbacks', () => {
      const output = `BROWSER_FALLBACK: {"intent": "change form email", "actions": [], "reason": "no tool"}
Some text in between
BROWSER_FALLBACK: {"intent": "edit gallery caption", "actions": ["clicked image"], "reason": "no gallery API"}`;

      const fallbacks = parseBrowserFallbacks(output);
      expect(fallbacks).toHaveLength(2);
      expect(fallbacks[0].intent).toBe('change form email');
      expect(fallbacks[1].intent).toBe('edit gallery caption');
    });

    it('should handle malformed JSON gracefully', () => {
      const output = `BROWSER_FALLBACK: {not valid json at all}`;

      const fallbacks = parseBrowserFallbacks(output);
      expect(fallbacks).toHaveLength(1);
      expect(fallbacks[0].intent).toBe('unstructured');
      expect(fallbacks[0].reason).toBe('{not valid json at all}');
      expect(fallbacks[0].actions).toEqual([]);
    });

    it('should return empty array when no fallbacks', () => {
      const output = 'I completed the task successfully using API tools only.';
      const fallbacks = parseBrowserFallbacks(output);
      expect(fallbacks).toHaveLength(0);
    });

    it('should handle fallbacks with selectors', () => {
      const output = `BROWSER_FALLBACK: {"intent": "upload file", "actions": ["navigate", "click"], "reason": "no upload API", "selectors": [".upload-btn", "input[type=file]"]}`;

      const fallbacks = parseBrowserFallbacks(output);
      expect(fallbacks).toHaveLength(1);
      expect(fallbacks[0].selectors).toEqual(['.upload-btn', 'input[type=file]']);
    });

    it('should handle missing optional fields', () => {
      const output = `BROWSER_FALLBACK: {"intent": "do thing", "reason": "no API"}`;

      const fallbacks = parseBrowserFallbacks(output);
      expect(fallbacks).toHaveLength(1);
      expect(fallbacks[0].intent).toBe('do thing');
      expect(fallbacks[0].actions).toEqual([]);
      expect(fallbacks[0].selectors).toBeUndefined();
    });

    it('should parse fallbacks from each call independently (no regex state leak)', () => {
      const output1 = `BROWSER_FALLBACK: {"intent": "first", "actions": [], "reason": "test"}`;
      const output2 = `BROWSER_FALLBACK: {"intent": "second", "actions": [], "reason": "test"}`;

      const result1 = parseBrowserFallbacks(output1);
      const result2 = parseBrowserFallbacks(output2);

      expect(result1).toHaveLength(1);
      expect(result1[0].intent).toBe('first');
      expect(result2).toHaveLength(1);
      expect(result2[0].intent).toBe('second');
    });
  });

  describe('logBrowserFallback', () => {
    it('should insert new fallback when none exists', () => {
      const mockGet = vi.fn().mockReturnValue(undefined);
      const mockRun = vi.fn();
      mockPrepare.mockReturnValue({ get: mockGet, run: mockRun });

      logBrowserFallback('smyth-tavern', 'home', {
        intent: 'change form email',
        actions: ['clicked form'],
        reason: 'no API tool',
      });

      // First call: SELECT to check for existing
      expect(mockPrepare).toHaveBeenCalledTimes(2);
      expect(mockGet).toHaveBeenCalledWith('change form email', 'smyth-tavern');

      // Second call: INSERT
      expect(mockRun).toHaveBeenCalled();
      const insertArgs = mockRun.mock.calls[0];
      expect(insertArgs[0]).toBe('smyth-tavern');
      expect(insertArgs[1]).toBe('home');
      expect(insertArgs[2]).toBe('change form email');
    });

    it('should increment count when fallback already exists', () => {
      const mockGet = vi.fn().mockReturnValue({ id: 42, occurrence_count: 3 });
      const mockRun = vi.fn();
      mockPrepare.mockReturnValue({ get: mockGet, run: mockRun });

      logBrowserFallback('smyth-tavern', 'home', {
        intent: 'change form email',
        actions: [],
        reason: 'no API tool',
      });

      // Should UPDATE with incremented count
      const updateArgs = mockRun.mock.calls[0];
      expect(updateArgs[0]).toBe(4); // occurrence_count + 1
    });

    it('should pass taskId when provided', () => {
      const mockGet = vi.fn().mockReturnValue(undefined);
      const mockRun = vi.fn();
      mockPrepare.mockReturnValue({ get: mockGet, run: mockRun });

      logBrowserFallback('smyth-tavern', 'home', {
        intent: 'test',
        actions: [],
        reason: 'test',
      }, 'task-abc');

      const insertArgs = mockRun.mock.calls[0];
      expect(insertArgs[6]).toBe('task-abc');
    });
  });

  describe('getUnresolvedFallbacks', () => {
    it('should query unresolved fallbacks ordered by occurrence count', () => {
      const mockAll = vi.fn().mockReturnValue([
        { id: 1, intent: 'form email', occurrence_count: 5 },
        { id: 2, intent: 'gallery caption', occurrence_count: 2 },
      ]);
      mockPrepare.mockReturnValue({ all: mockAll });

      const result = getUnresolvedFallbacks();

      expect(result).toHaveLength(2);
      expect(result[0].occurrence_count).toBe(5);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('WHERE resolved = 0'),
      );
    });
  });

  describe('resolveFallback', () => {
    it('should mark fallback as resolved with tool name', () => {
      const mockRun = vi.fn();
      mockPrepare.mockReturnValue({ run: mockRun });

      resolveFallback(42, 'sq_update_form_settings');

      expect(mockRun).toHaveBeenCalledWith('sq_update_form_settings', 42);
    });
  });
});
