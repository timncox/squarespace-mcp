import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task } from '../../models/task.js';
import type { Conversation } from '../../models/conversation.js';
import type { SimpleEditClassification } from '../simple-edit-classifier.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockClassifySimpleEdit = vi.fn();
const mockExecuteSimpleEdit = vi.fn();
const mockUpdateConversationStatus = vi.fn();
const mockUpdateTaskStatus = vi.fn();
const mockLogAction = vi.fn();
const mockSendToTim = vi.fn();

vi.mock('../simple-edit-classifier.js', () => ({
  classifySimpleEdit: (...args: unknown[]) => mockClassifySimpleEdit(...args),
}));

vi.mock('../simple-edit-executor.js', () => ({
  executeSimpleEdit: (...args: unknown[]) => mockExecuteSimpleEdit(...args),
}));

vi.mock('../../db/conversations.js', () => ({
  updateConversationStatus: (...args: unknown[]) => mockUpdateConversationStatus(...args),
  updateConversationFeedback: vi.fn(),
  createConversation: vi.fn(),
}));

vi.mock('../../db/tasks.js', () => ({
  createTask: vi.fn(),
  getTask: vi.fn(),
  updateTaskStatus: (...args: unknown[]) => mockUpdateTaskStatus(...args),
  updateTaskSiteInfo: vi.fn(),
}));

vi.mock('../whatsapp.js', () => ({
  sendToTim: (...args: unknown[]) => mockSendToTim(...args),
  sendButtonsToTim: vi.fn(),
}));

vi.mock('../../db/audit-log.js', () => ({
  logAction: (...args: unknown[]) => mockLogAction(...args),
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

import { trySimpleEditFastPath } from '../conversation/message-handlers.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    taskType: 'general_edit',
    clientName: 'Test Client',
    siteId: 'test-site',
    targetPage: 'home',
    applyToAllSites: false,
    needsClarification: false,
    status: 'confirmed',
    attemptCount: 0,
    createdAt: '2026-02-27T00:00:00Z',
    updatedAt: '2026-02-27T00:00:00Z',
    ...overrides,
  };
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    source: 'whatsapp',
    status: 'awaiting_confirm',
    taskIds: ['task-1'],
    summaryText: 'Test task',
    createdAt: '2026-02-27T00:00:00Z',
    updatedAt: '2026-02-27T00:00:00Z',
    ...overrides,
  };
}

function highConfidenceClassification(editType: string = 'text_replace'): SimpleEditClassification {
  return {
    isSimpleEdit: true,
    editType: editType as SimpleEditClassification['editType'],
    confidence: 'high',
    params: { searchText: 'old text', newContent: 'new text' },
    reason: 'Direct text replacement',
  };
}

function notSimpleClassification(): SimpleEditClassification {
  return {
    isSimpleEdit: false,
    confidence: 'high',
    params: {},
    reason: 'Task requires full content planning',
  };
}

function mediumConfidenceClassification(): SimpleEditClassification {
  return {
    isSimpleEdit: true,
    editType: 'text_replace',
    confidence: 'medium',
    params: { searchText: 'old text', newContent: 'new text' },
    reason: 'Likely a text replacement but not certain',
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('trySimpleEditFastPath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns summary when all tasks are simple edits with high confidence', async () => {
    const conversation = makeConversation();
    const tasks = [
      makeTask({ id: 'task-1', description: 'Change phone number to 555-1234' }),
      makeTask({ id: 'task-2', description: 'Update address to 123 Main St' }),
    ];

    mockClassifySimpleEdit
      .mockResolvedValueOnce(highConfidenceClassification('text_replace'))
      .mockResolvedValueOnce(highConfidenceClassification('text_replace'));

    mockExecuteSimpleEdit
      .mockResolvedValueOnce({
        success: true,
        editType: 'text_replace',
        summary: 'Updated phone number',
        durationMs: 250,
      })
      .mockResolvedValueOnce({
        success: true,
        editType: 'text_replace',
        summary: 'Updated address',
        durationMs: 300,
      });

    const result = await trySimpleEditFastPath(conversation, tasks);

    expect(result).not.toBeNull();
    expect(result).toContain('Fast edit');
    expect(result).toContain('Updated phone number');
    expect(result).toContain('Updated address');
    expect(result).toContain('250ms');
    expect(result).toContain('300ms');

    // Should have set task status to executing for each task
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith('task-1', 'executing');
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith('task-2', 'executing');

    // Should have logged start and done for each task
    expect(mockLogAction).toHaveBeenCalledTimes(4); // 2 starts + 2 dones
  });

  it('returns null when one task is not a simple edit', async () => {
    const conversation = makeConversation();
    const tasks = [
      makeTask({ id: 'task-1', description: 'Change phone number' }),
      makeTask({ id: 'task-2', description: 'Create a new gallery page' }),
    ];

    mockClassifySimpleEdit
      .mockResolvedValueOnce(highConfidenceClassification())
      .mockResolvedValueOnce(notSimpleClassification());

    const result = await trySimpleEditFastPath(conversation, tasks);

    expect(result).toBeNull();
    // executeSimpleEdit should NOT have been called
    expect(mockExecuteSimpleEdit).not.toHaveBeenCalled();
  });

  it('returns null when confidence is medium (not high)', async () => {
    const conversation = makeConversation();
    const tasks = [makeTask({ description: 'Maybe change some text' })];

    mockClassifySimpleEdit.mockResolvedValueOnce(mediumConfidenceClassification());

    const result = await trySimpleEditFastPath(conversation, tasks);

    expect(result).toBeNull();
    expect(mockExecuteSimpleEdit).not.toHaveBeenCalled();
  });

  it('returns null and resets task statuses when execution fails', async () => {
    const conversation = makeConversation({ taskIds: ['task-1', 'task-2'] });
    const tasks = [
      makeTask({ id: 'task-1' }),
      makeTask({ id: 'task-2' }),
    ];

    mockClassifySimpleEdit
      .mockResolvedValueOnce(highConfidenceClassification())
      .mockResolvedValueOnce(highConfidenceClassification());

    // First task succeeds, second fails
    mockExecuteSimpleEdit
      .mockResolvedValueOnce({
        success: true,
        editType: 'text_replace',
        summary: 'Updated text',
        durationMs: 200,
      })
      .mockResolvedValueOnce({
        success: false,
        editType: 'text_replace',
        error: 'Session expired',
        summary: '',
        durationMs: 0,
      });

    const result = await trySimpleEditFastPath(conversation, tasks);

    expect(result).toBeNull();

    // Both tasks should be reset to confirmed
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith('task-1', 'confirmed');
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith('task-2', 'confirmed');
  });

  it('returns null immediately when tasks have images', async () => {
    const conversation = makeConversation();
    const tasks = [
      makeTask({ referenceImagePath: '/path/to/screenshot.png' }),
    ];

    const result = await trySimpleEditFastPath(conversation, tasks);

    expect(result).toBeNull();
    expect(mockClassifySimpleEdit).not.toHaveBeenCalled();
  });

  it('returns null immediately when tasks have imagePaths', async () => {
    const conversation = makeConversation();
    const tasks = [
      makeTask({ imagePaths: ['/path/to/image1.jpg', '/path/to/image2.jpg'] }),
    ];

    const result = await trySimpleEditFastPath(conversation, tasks);

    expect(result).toBeNull();
    expect(mockClassifySimpleEdit).not.toHaveBeenCalled();
  });

  it('returns null immediately when conversation has an existing plan', async () => {
    const conversation = makeConversation({ contentPlan: '{"operations":[]}' });
    const tasks = [makeTask()];

    const result = await trySimpleEditFastPath(conversation, tasks);

    expect(result).toBeNull();
    expect(mockClassifySimpleEdit).not.toHaveBeenCalled();
  });

  it('returns null gracefully when classifier throws', async () => {
    const conversation = makeConversation();
    const tasks = [makeTask()];

    mockClassifySimpleEdit.mockRejectedValueOnce(new Error('API rate limited'));

    const result = await trySimpleEditFastPath(conversation, tasks);

    expect(result).toBeNull();
    expect(mockExecuteSimpleEdit).not.toHaveBeenCalled();
  });

  it('returns null for empty task list', async () => {
    const conversation = makeConversation({ taskIds: [] });
    const result = await trySimpleEditFastPath(conversation, []);

    expect(result).toBeNull();
    expect(mockClassifySimpleEdit).not.toHaveBeenCalled();
  });

  it('returns summary for a single task', async () => {
    const conversation = makeConversation();
    const tasks = [makeTask({ description: 'Update the phone number' })];

    mockClassifySimpleEdit.mockResolvedValueOnce(highConfidenceClassification());
    mockExecuteSimpleEdit.mockResolvedValueOnce({
      success: true,
      editType: 'text_replace',
      summary: 'Replaced phone number',
      durationMs: 150,
    });

    const result = await trySimpleEditFastPath(conversation, tasks);

    expect(result).not.toBeNull();
    // Single task should say "edit" not "edits"
    expect(result).toContain('Fast edit complete');
    expect(result).not.toContain('edits');
  });

  it('returns null when some classifications are high and some medium', async () => {
    const conversation = makeConversation();
    const tasks = [
      makeTask({ id: 'task-1' }),
      makeTask({ id: 'task-2' }),
    ];

    mockClassifySimpleEdit
      .mockResolvedValueOnce(highConfidenceClassification())
      .mockResolvedValueOnce(mediumConfidenceClassification());

    const result = await trySimpleEditFastPath(conversation, tasks);

    expect(result).toBeNull();
    expect(mockExecuteSimpleEdit).not.toHaveBeenCalled();
  });

  it('classifies all tasks in parallel', async () => {
    const conversation = makeConversation();
    const tasks = [
      makeTask({ id: 'task-1' }),
      makeTask({ id: 'task-2' }),
      makeTask({ id: 'task-3' }),
    ];

    // All resolve at once — should be called via Promise.all
    mockClassifySimpleEdit.mockResolvedValue(highConfidenceClassification());
    mockExecuteSimpleEdit.mockResolvedValue({
      success: true,
      editType: 'text_replace',
      summary: 'Updated text',
      durationMs: 100,
    });

    await trySimpleEditFastPath(conversation, tasks);

    // All 3 classifications should have been requested
    expect(mockClassifySimpleEdit).toHaveBeenCalledTimes(3);
  });
});
