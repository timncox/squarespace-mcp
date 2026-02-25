import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { ContentPlan } from '../../agents/types.js';

// ── Mock the database module to use an in-memory SQLite database ────────────

let testDb: Database.Database;

vi.mock('../database.js', () => ({
  getDb: () => testDb,
}));

// Suppress logger output during tests
vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock dashboard-events (dynamic import used in updateOperationStatus)
vi.mock('../../services/dashboard-events.js', () => ({
  dashboardEvents: {
    emit: vi.fn(),
  },
}));

import {
  createPlanOperations,
  updateOperationStatus,
  getOperationById,
  getOperationsByConversation,
  getOperationsByTask,
  getFailedOperations,
  getPlanOperationSummary,
  getOperationsByConversationAndTask,
} from '../plan-operations.js';

// ── Test Setup ──────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  // Create the plan_operations table (same as migration)
  db.exec(`
    CREATE TABLE IF NOT EXISTS plan_operations (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      task_id TEXT,
      operation_index INTEGER NOT NULL,
      operation_type TEXT NOT NULL,
      target_page TEXT,
      placement TEXT,
      content_strategy TEXT,
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_plan_ops_conversation ON plan_operations(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_plan_ops_task ON plan_operations(task_id);
    CREATE INDEX IF NOT EXISTS idx_plan_ops_status ON plan_operations(status);
  `);

  return db;
}

function makePlan(opCount: number): ContentPlan {
  const operations = Array.from({ length: opCount }, (_, i) => ({
    taskId: `task-${Math.floor(i / 2) + 1}`,
    siteId: 'test-site',
    targetPage: i % 2 === 0 ? 'home' : 'about',
    operationType: i % 2 === 0 ? 'add_section' as const : 'modify_text' as const,
    placement: `Section ${i + 1}`,
    content: {
      heading: `Heading ${i + 1}`,
      contentStrategy: i % 3 === 0 ? 'blank_api' as const : 'template' as const,
    },
    editorInstruction: `Edit step ${i + 1}`,
  }));

  return {
    summary: 'Test plan',
    operations,
    sources: [],
    estimatedMinutes: 5,
  };
}

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.close();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('createPlanOperations', () => {
  it('should create operations for all plan entries', () => {
    const plan = makePlan(4);
    const ops = createPlanOperations('conv-1', plan);

    expect(ops).toHaveLength(4);
    expect(ops[0].conversationId).toBe('conv-1');
    expect(ops[0].operationIndex).toBe(0);
    expect(ops[0].status).toBe('pending');
    expect(ops[0].operationType).toBe('add_section');
    expect(ops[1].operationType).toBe('modify_text');
    expect(ops[2].operationIndex).toBe(2);
    expect(ops[3].operationIndex).toBe(3);
  });

  it('should generate unique IDs for each operation', () => {
    const plan = makePlan(3);
    const ops = createPlanOperations('conv-2', plan);

    const ids = ops.map((o) => o.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(3);
  });

  it('should persist operations to the database', () => {
    const plan = makePlan(2);
    createPlanOperations('conv-3', plan);

    const rows = testDb.prepare('SELECT * FROM plan_operations WHERE conversation_id = ?').all('conv-3');
    expect(rows).toHaveLength(2);
  });

  it('should store content strategy from the operation content', () => {
    const plan = makePlan(3);
    const ops = createPlanOperations('conv-4', plan);

    expect(ops[0].contentStrategy).toBe('blank_api');
    expect(ops[1].contentStrategy).toBe('template');
    expect(ops[2].contentStrategy).toBe('template');
  });

  it('should store taskId from each operation', () => {
    const plan = makePlan(4);
    const ops = createPlanOperations('conv-5', plan);

    expect(ops[0].taskId).toBe('task-1');
    expect(ops[1].taskId).toBe('task-1');
    expect(ops[2].taskId).toBe('task-2');
    expect(ops[3].taskId).toBe('task-2');
  });

  it('should handle empty plan with zero operations', () => {
    const plan: ContentPlan = {
      summary: 'Empty plan',
      operations: [],
      sources: [],
      estimatedMinutes: 0,
    };
    const ops = createPlanOperations('conv-6', plan);
    expect(ops).toHaveLength(0);
  });
});

describe('updateOperationStatus', () => {
  it('should update status to executing and set started_at', () => {
    const plan = makePlan(1);
    const ops = createPlanOperations('conv-10', plan);

    updateOperationStatus(ops[0].id, 'executing');

    const updated = getOperationById(ops[0].id);
    expect(updated?.status).toBe('executing');
    expect(updated?.startedAt).toBeTruthy();
    expect(updated?.completedAt).toBeNull();
  });

  it('should update status to succeeded and set completed_at', () => {
    const plan = makePlan(1);
    const ops = createPlanOperations('conv-11', plan);

    updateOperationStatus(ops[0].id, 'executing');
    updateOperationStatus(ops[0].id, 'succeeded');

    const updated = getOperationById(ops[0].id);
    expect(updated?.status).toBe('succeeded');
    expect(updated?.completedAt).toBeTruthy();
    expect(updated?.startedAt).toBeTruthy();
  });

  it('should update status to failed with error message', () => {
    const plan = makePlan(1);
    const ops = createPlanOperations('conv-12', plan);

    updateOperationStatus(ops[0].id, 'failed', 'Something went wrong');

    const updated = getOperationById(ops[0].id);
    expect(updated?.status).toBe('failed');
    expect(updated?.errorMessage).toBe('Something went wrong');
    expect(updated?.completedAt).toBeTruthy();
  });

  it('should update status to skipped with reason', () => {
    const plan = makePlan(1);
    const ops = createPlanOperations('conv-13', plan);

    updateOperationStatus(ops[0].id, 'skipped', 'Fell through to browser agent');

    const updated = getOperationById(ops[0].id);
    expect(updated?.status).toBe('skipped');
    expect(updated?.errorMessage).toBe('Fell through to browser agent');
  });

  it('should preserve started_at when transitioning from executing to succeeded', () => {
    const plan = makePlan(1);
    const ops = createPlanOperations('conv-14', plan);

    updateOperationStatus(ops[0].id, 'executing');
    const afterExec = getOperationById(ops[0].id);
    const startedAt = afterExec?.startedAt;

    updateOperationStatus(ops[0].id, 'succeeded');
    const afterSuccess = getOperationById(ops[0].id);

    expect(afterSuccess?.startedAt).toBe(startedAt);
  });
});

describe('getOperationsByConversation', () => {
  it('should return all operations ordered by index', () => {
    const plan = makePlan(4);
    createPlanOperations('conv-20', plan);

    const ops = getOperationsByConversation('conv-20');
    expect(ops).toHaveLength(4);
    expect(ops[0].operationIndex).toBe(0);
    expect(ops[1].operationIndex).toBe(1);
    expect(ops[2].operationIndex).toBe(2);
    expect(ops[3].operationIndex).toBe(3);
  });

  it('should return empty array for unknown conversation', () => {
    const ops = getOperationsByConversation('unknown');
    expect(ops).toHaveLength(0);
  });
});

describe('getOperationsByTask', () => {
  it('should return only operations for the given task', () => {
    const plan = makePlan(4);
    createPlanOperations('conv-25', plan);

    const task1Ops = getOperationsByTask('task-1');
    expect(task1Ops).toHaveLength(2);
    expect(task1Ops.every((o) => o.taskId === 'task-1')).toBe(true);

    const task2Ops = getOperationsByTask('task-2');
    expect(task2Ops).toHaveLength(2);
    expect(task2Ops.every((o) => o.taskId === 'task-2')).toBe(true);
  });
});

describe('getFailedOperations', () => {
  it('should return only failed operations', () => {
    const plan = makePlan(3);
    const ops = createPlanOperations('conv-30', plan);

    updateOperationStatus(ops[0].id, 'succeeded');
    updateOperationStatus(ops[1].id, 'failed', 'Error 1');
    updateOperationStatus(ops[2].id, 'failed', 'Error 2');

    const failed = getFailedOperations('conv-30');
    expect(failed).toHaveLength(2);
    expect(failed[0].errorMessage).toBe('Error 1');
    expect(failed[1].errorMessage).toBe('Error 2');
  });

  it('should return empty when no operations have failed', () => {
    const plan = makePlan(2);
    const ops = createPlanOperations('conv-31', plan);

    updateOperationStatus(ops[0].id, 'succeeded');
    updateOperationStatus(ops[1].id, 'succeeded');

    const failed = getFailedOperations('conv-31');
    expect(failed).toHaveLength(0);
  });
});

describe('getPlanOperationSummary', () => {
  it('should return correct counts for all statuses', () => {
    const plan = makePlan(5);
    const ops = createPlanOperations('conv-40', plan);

    updateOperationStatus(ops[0].id, 'succeeded');
    updateOperationStatus(ops[1].id, 'succeeded');
    updateOperationStatus(ops[2].id, 'failed', 'Oops');
    updateOperationStatus(ops[3].id, 'executing');
    // ops[4] stays pending

    const summary = getPlanOperationSummary('conv-40');
    expect(summary.total).toBe(5);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.executing).toBe(1);
    expect(summary.pending).toBe(1);
    expect(summary.skipped).toBe(0);
  });

  it('should return all zeros for unknown conversation', () => {
    const summary = getPlanOperationSummary('unknown');
    expect(summary.total).toBe(0);
    expect(summary.succeeded).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.pending).toBe(0);
  });
});

describe('getOperationsByConversationAndTask', () => {
  it('should filter by both conversation and task', () => {
    const plan = makePlan(4);
    createPlanOperations('conv-50', plan);

    const ops = getOperationsByConversationAndTask('conv-50', 'task-1');
    expect(ops).toHaveLength(2);
    expect(ops.every((o) => o.conversationId === 'conv-50' && o.taskId === 'task-1')).toBe(true);
  });
});

describe('getOperationById', () => {
  it('should return undefined for nonexistent ID', () => {
    const result = getOperationById('nonexistent');
    expect(result).toBeUndefined();
  });

  it('should return the correct operation', () => {
    const plan = makePlan(2);
    const ops = createPlanOperations('conv-60', plan);

    const result = getOperationById(ops[1].id);
    expect(result).toBeDefined();
    expect(result?.operationIndex).toBe(1);
    expect(result?.conversationId).toBe('conv-60');
  });
});
