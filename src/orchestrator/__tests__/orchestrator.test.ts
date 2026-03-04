import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock runAgent
vi.mock('../cli-runner.js', () => ({
  runAgent: vi.fn(),
}));

// Mock fallback-tracker
vi.mock('../fallback-tracker.js', () => ({
  parseBrowserFallbacks: vi.fn(() => []),
  logBrowserFallback: vi.fn(),
}));

// Mock dashboard events
vi.mock('../../services/dashboard-events.js', () => ({
  dashboardEvents: { emit: vi.fn() },
}));

// Mock plan-operations
vi.mock('../../db/plan-operations.js', () => ({
  createPlanOperations: vi.fn(() => []),
  updateOperationStatus: vi.fn(),
}));

// Mock logger
vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { orchestrateTask, classifyTask, type OrchestratorResult } from '../orchestrator.js';
import { runAgent } from '../cli-runner.js';
import { parseBrowserFallbacks, logBrowserFallback } from '../fallback-tracker.js';
import { dashboardEvents } from '../../services/dashboard-events.js';
import { createPlanOperations } from '../../db/plan-operations.js';
import type { Task } from '../../models/task.js';
import type { Conversation } from '../../models/conversation.js';

const mockRunAgent = vi.mocked(runAgent);
const mockParseFallbacks = vi.mocked(parseBrowserFallbacks);
const mockLogFallback = vi.mocked(logBrowserFallback);
const mockEmit = vi.mocked(dashboardEvents.emit);
const mockCreatePlanOps = vi.mocked(createPlanOperations);

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    taskType: 'general_edit',
    clientName: 'Test Client',
    siteId: 'test-site',
    targetPage: 'home',
    description: 'Update the heading text',
    applyToAllSites: false,
    needsClarification: false,
    status: 'confirmed',
    attemptCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    source: 'dashboard',
    status: 'executing',
    taskIds: ['task-1'],
    summaryText: 'Test conversation',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function mockAgentResult(text: string, cost = 0.01) {
  return {
    success: true,
    text,
    usage: { input_tokens: 100, output_tokens: 50 },
    cost,
    numTurns: 1,
    sessionId: 'sess-1',
  };
}

/** Returns a valid ContentPlan JSON string for strategist mock responses */
function makeContentPlanJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    summary: 'Update heading text on homepage',
    operations: [
      {
        operationType: 'modify_text',
        description: 'Update the heading to new text',
        targetPage: 'home',
        placement: 'section 1',
        content: {
          contentStrategy: 'manual',
          heading: 'New Heading',
        },
      },
    ],
    estimatedMinutes: 2,
    ...overrides,
  });
}

describe('orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: createPlanOperations returns tracked ops matching the plan
    mockCreatePlanOps.mockReturnValue([
      { id: 'op-1', conversationId: 'conv-1', operationType: 'modify_text', targetPage: 'home', description: 'Update heading', status: 'pending', createdAt: new Date().toISOString() },
    ] as any);
  });

  describe('classifyTask', () => {
    it('should route simple tasks correctly', async () => {
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ route: 'simple', confidence: 'high', simpleEditType: 'text_edit' })),
      );

      const result = await classifyTask(makeTask());

      expect(result.route).toBe('simple');
      expect(result.simpleEditType).toBe('text_edit');
    });

    it('should route to pipeline when confidence is low', async () => {
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ route: 'simple', confidence: 'low', simpleEditType: 'text_edit' })),
      );

      const result = await classifyTask(makeTask());

      expect(result.route).toBe('pipeline');
    });

    it('should default to pipeline on classifier failure', async () => {
      mockRunAgent.mockRejectedValueOnce(new Error('Classifier timeout'));

      const result = await classifyTask(makeTask());

      expect(result.route).toBe('pipeline');
    });

    it('should default to pipeline when route is pipeline', async () => {
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ route: 'pipeline', confidence: 'high' })),
      );

      const result = await classifyTask(makeTask());

      expect(result.route).toBe('pipeline');
    });
  });

  describe('orchestrateTask', () => {
    it('should run full pipeline and return success on pass verdict', async () => {
      // classifier → pipeline
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ route: 'pipeline' })),
      );
      // analyst
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Site has 3 sections with heading and text blocks', 0.02));
      // strategist — must return valid ContentPlan JSON
      mockRunAgent.mockResolvedValueOnce(mockAgentResult(makeContentPlanJson(), 0.03));
      // executor
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Heading updated to new text', 0.05));
      // supervisor
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ verdict: 'pass', issues: [], suggestions: [] }), 0.02),
      );

      const result = await orchestrateTask(makeTask(), makeConversation());

      expect(result.success).toBe(true);
      expect(result.verdict?.verdict).toBe('pass');
      expect(result.agentCosts.analyst).toBe(0.02);
      expect(result.agentCosts.strategist).toBe(0.03);
      expect(result.agentCosts.executor).toBe(0.05);
      expect(result.agentCosts.supervisor).toBe(0.02);
      expect(result.totalCost).toBeCloseTo(0.12, 5);
    });

    it('should skip research when not needed', async () => {
      // classifier
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ route: 'pipeline' })),
      );
      // analyst
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Analysis'));
      // strategist
      mockRunAgent.mockResolvedValueOnce(mockAgentResult(makeContentPlanJson()));
      // executor
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Done'));
      // supervisor
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ verdict: 'pass', issues: [], suggestions: [] })),
      );

      const task = makeTask({ description: 'Update the heading text' });
      await orchestrateTask(task, makeConversation());

      // classifier + analyst + strategist + executor + supervisor = 5 calls (no researcher)
      expect(mockRunAgent).toHaveBeenCalledTimes(5);
    });

    it('should include research when task mentions URLs', async () => {
      // classifier
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ route: 'pipeline' })),
      );
      // researcher
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Research findings'));
      // analyst
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Analysis'));
      // strategist
      mockRunAgent.mockResolvedValueOnce(mockAgentResult(makeContentPlanJson()));
      // executor
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Done'));
      // supervisor
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ verdict: 'pass', issues: [], suggestions: [] })),
      );

      const task = makeTask({ description: 'Add content from https://example.com' });
      await orchestrateTask(task, makeConversation());

      // classifier + researcher + analyst + strategist + executor + supervisor = 6
      expect(mockRunAgent).toHaveBeenCalledTimes(6);
    });

    it('should abort pipeline on analyst failure', async () => {
      // classifier
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ route: 'pipeline' })),
      );
      // analyst fails
      mockRunAgent.mockRejectedValueOnce(new Error('Analyst timeout'));

      const result = await orchestrateTask(makeTask(), makeConversation());

      expect(result.success).toBe(false);
      expect(result.fallbacks).toEqual([]);
      expect(mockRunAgent).toHaveBeenCalledTimes(2);
    });

    it('should abort pipeline on strategist failure', async () => {
      // classifier
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ route: 'pipeline' })),
      );
      // analyst
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Analysis', 0.02));
      // strategist fails
      mockRunAgent.mockRejectedValueOnce(new Error('Strategist timeout'));

      const result = await orchestrateTask(makeTask(), makeConversation());

      expect(result.success).toBe(false);
      expect(result.agentCosts.analyst).toBe(0.02);
      expect(result.totalCost).toBe(0.02);
    });

    it('should abort pipeline when strategist returns invalid JSON', async () => {
      // classifier
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ route: 'pipeline' })),
      );
      // analyst
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Analysis', 0.02));
      // strategist returns invalid JSON
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Here is my plan in free text...', 0.03));

      const result = await orchestrateTask(makeTask(), makeConversation());

      expect(result.success).toBe(false);
      expect(result.agentCosts.analyst).toBe(0.02);
      expect(result.agentCosts.strategist).toBe(0.03);
      expect(result.totalCost).toBe(0.05);
      // Should not proceed to executor
      expect(mockRunAgent).toHaveBeenCalledTimes(3);
    });

    it('should abort pipeline on executor failure', async () => {
      // classifier
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ route: 'pipeline' })),
      );
      // analyst
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Analysis', 0.02));
      // strategist
      mockRunAgent.mockResolvedValueOnce(mockAgentResult(makeContentPlanJson(), 0.03));
      // executor fails
      mockRunAgent.mockRejectedValueOnce(new Error('Executor timeout'));

      const result = await orchestrateTask(makeTask(), makeConversation());

      expect(result.success).toBe(false);
      expect(result.agentCosts.analyst).toBe(0.02);
      expect(result.agentCosts.strategist).toBe(0.03);
      expect(result.totalCost).toBe(0.05);
    });

    it('should create plan operations after parsing ContentPlan', async () => {
      // classifier
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ route: 'pipeline' })),
      );
      // analyst
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Analysis'));
      // strategist
      const planJson = makeContentPlanJson();
      mockRunAgent.mockResolvedValueOnce(mockAgentResult(planJson));
      // executor
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Done'));
      // supervisor
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ verdict: 'pass', issues: [], suggestions: [] })),
      );

      await orchestrateTask(makeTask(), makeConversation());

      expect(mockCreatePlanOps).toHaveBeenCalledWith('conv-1', JSON.parse(planJson));
    });

    it('should emit operation_update events for tracked operations', async () => {
      mockCreatePlanOps.mockReturnValue([
        { id: 'op-1', conversationId: 'conv-1', operationType: 'modify_text', targetPage: 'home', description: 'Update heading', status: 'pending', createdAt: new Date().toISOString() },
        { id: 'op-2', conversationId: 'conv-1', operationType: 'add_section', targetPage: 'home', description: 'Add about section', status: 'pending', createdAt: new Date().toISOString() },
      ] as any);

      // classifier
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ route: 'pipeline' })),
      );
      // analyst
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Analysis'));
      // strategist
      mockRunAgent.mockResolvedValueOnce(mockAgentResult(makeContentPlanJson({
        operations: [
          { operationType: 'modify_text', description: 'Update heading', targetPage: 'home', placement: 'section 1', content: {} },
          { operationType: 'add_section', description: 'Add about section', targetPage: 'home', placement: 'after section 1', content: {} },
        ],
      })));
      // executor
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Done'));
      // supervisor
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ verdict: 'pass', issues: [], suggestions: [] })),
      );

      await orchestrateTask(makeTask(), makeConversation());

      const opUpdateCalls = mockEmit.mock.calls.filter(([type, evt]) => type === 'dashboard' && evt?.type === 'operation_update');
      expect(opUpdateCalls.length).toBe(2);
      expect(opUpdateCalls[0][1].data).toMatchObject({ operationId: 'op-1', status: 'pending' });
      expect(opUpdateCalls[1][1].data).toMatchObject({ operationId: 'op-2', status: 'pending' });
    });

    it('should continue when createPlanOperations fails', async () => {
      mockCreatePlanOps.mockImplementation(() => { throw new Error('DB error'); });

      // classifier
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ route: 'pipeline' })),
      );
      // analyst
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Analysis'));
      // strategist
      mockRunAgent.mockResolvedValueOnce(mockAgentResult(makeContentPlanJson()));
      // executor
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Done'));
      // supervisor
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ verdict: 'pass', issues: [], suggestions: [] })),
      );

      const result = await orchestrateTask(makeTask(), makeConversation());

      // Should still succeed — tracking is non-blocking
      expect(result.success).toBe(true);
    });

    it('should log executor browser fallbacks', async () => {
      const fallbacks = [
        { intent: 'edit_image', actions: ['click', 'upload'], reason: 'No API tool available', selectors: ['.image-block'] },
      ];

      // classifier
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ route: 'pipeline' })),
      );
      // analyst
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Analysis'));
      // strategist
      mockRunAgent.mockResolvedValueOnce(mockAgentResult(makeContentPlanJson()));
      // executor — output with fallback marker
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Done with BROWSER_FALLBACK: {"intent":"edit_image"}'));
      // supervisor
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ verdict: 'pass', issues: [], suggestions: [] })),
      );

      mockParseFallbacks.mockReturnValueOnce(fallbacks);

      const result = await orchestrateTask(makeTask(), makeConversation());

      expect(mockParseFallbacks).toHaveBeenCalledWith('Done with BROWSER_FALLBACK: {"intent":"edit_image"}');
      expect(mockLogFallback).toHaveBeenCalledWith('test-site', 'home', fallbacks[0], 'task-1');
      expect(result.fallbacks).toEqual(fallbacks);
    });

    it('should parse supervisor verdict correctly', async () => {
      // classifier
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ route: 'pipeline' })),
      );
      // analyst
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Analysis'));
      // strategist
      mockRunAgent.mockResolvedValueOnce(mockAgentResult(makeContentPlanJson()));
      // executor
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Done'));
      // supervisor returns partial verdict
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({
          verdict: 'partial',
          issues: ['Heading text slightly off'],
          suggestions: ['Check font size'],
        })),
      );

      const result = await orchestrateTask(makeTask(), makeConversation());

      expect(result.success).toBe(true); // partial is still success
      expect(result.verdict?.verdict).toBe('partial');
      expect(result.verdict?.issues).toEqual(['Heading text slightly off']);
      expect(result.verdict?.suggestions).toEqual(['Check font size']);
    });

    it('should handle unparseable supervisor output', async () => {
      // classifier
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ route: 'pipeline' })),
      );
      // analyst
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Analysis'));
      // strategist
      mockRunAgent.mockResolvedValueOnce(mockAgentResult(makeContentPlanJson()));
      // executor
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Done'));
      // supervisor returns non-JSON
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Looks good to me!'));

      const result = await orchestrateTask(makeTask(), makeConversation());

      expect(result.success).toBe(false); // unknown verdict → not pass/partial
      expect(result.verdict?.verdict).toBe('unknown');
      expect(result.verdict?.issues).toEqual(['Could not parse supervisor output']);
    });

    it('should treat supervisor failure as unverified', async () => {
      // classifier
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ route: 'pipeline' })),
      );
      // analyst
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Analysis'));
      // strategist
      mockRunAgent.mockResolvedValueOnce(mockAgentResult(makeContentPlanJson()));
      // executor
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Done'));
      // supervisor fails
      mockRunAgent.mockRejectedValueOnce(new Error('Supervisor timeout'));

      const result = await orchestrateTask(makeTask(), makeConversation());

      expect(result.success).toBe(false); // no verdict → not success
      expect(result.verdict).toBeUndefined();
    });

    it('should aggregate costs from all agents', async () => {
      // classifier
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ route: 'pipeline' }), 0.001),
      );
      // analyst
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Analysis', 0.02));
      // strategist
      mockRunAgent.mockResolvedValueOnce(mockAgentResult(makeContentPlanJson(), 0.03));
      // executor
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Done', 0.05));
      // supervisor
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ verdict: 'pass', issues: [], suggestions: [] }), 0.015),
      );

      const result = await orchestrateTask(makeTask(), makeConversation());

      // Classifier cost not tracked in agentCosts
      expect(result.agentCosts.analyst).toBe(0.02);
      expect(result.agentCosts.strategist).toBe(0.03);
      expect(result.agentCosts.executor).toBe(0.05);
      expect(result.agentCosts.supervisor).toBe(0.015);
      expect(result.totalCost).toBeCloseTo(0.115, 5);
    });

    it('should emit dashboard activity events for each stage', async () => {
      // classifier
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ route: 'pipeline' })),
      );
      // analyst
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Analysis'));
      // strategist
      mockRunAgent.mockResolvedValueOnce(mockAgentResult(makeContentPlanJson()));
      // executor
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Done'));
      // supervisor
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ verdict: 'pass', issues: [], suggestions: [] })),
      );

      await orchestrateTask(makeTask(), makeConversation());

      // Each agent gets started + completed = 2 events each
      // classifier, analyst, strategist, executor, supervisor = 5 agents x 2 = 10 events
      // All emitted via 'dashboard' envelope with type: 'agent_activity' inside
      const activityCalls = mockEmit.mock.calls.filter(([type, evt]) => type === 'dashboard' && evt?.type === 'agent_activity');
      expect(activityCalls.length).toBe(10);

      // Verify ordering: classifier started first
      expect(activityCalls[0][1].data).toMatchObject({ agent: 'classifier', status: 'started' });
      expect(activityCalls[1][1].data).toMatchObject({ agent: 'classifier', status: 'completed' });
    });

    it('should pass ContentPlan JSON to executor input', async () => {
      // classifier
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ route: 'pipeline' })),
      );
      // analyst
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Analysis'));
      // strategist
      const planJson = makeContentPlanJson();
      mockRunAgent.mockResolvedValueOnce(mockAgentResult(planJson));
      // executor
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Done'));
      // supervisor
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ verdict: 'pass', issues: [], suggestions: [] })),
      );

      await orchestrateTask(makeTask(), makeConversation());

      // Executor is the 4th runAgent call (index 3)
      const executorCall = mockRunAgent.mock.calls[3];
      const executorInput = executorCall[1] as string;
      expect(executorInput).toContain('Site: test-site');
      expect(executorInput).toContain('Target page: home');
      expect(executorInput).toContain('## Plan (ContentPlan JSON)');
      expect(executorInput).toContain('"modify_text"');
    });

    it('should pass ContentPlan JSON to supervisor input', async () => {
      // classifier
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ route: 'pipeline' })),
      );
      // analyst
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Analysis'));
      // strategist
      mockRunAgent.mockResolvedValueOnce(mockAgentResult(makeContentPlanJson()));
      // executor
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Executor output here'));
      // supervisor
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ verdict: 'pass', issues: [], suggestions: [] })),
      );

      await orchestrateTask(makeTask(), makeConversation());

      // Supervisor is the 5th runAgent call (index 4)
      const supervisorCall = mockRunAgent.mock.calls[4];
      const supervisorInput = supervisorCall[1] as string;
      expect(supervisorInput).toContain('## ContentPlan');
      expect(supervisorInput).toContain('"modify_text"');
      expect(supervisorInput).toContain('## Executor Result');
      expect(supervisorInput).toContain('Executor output here');
    });
  });
});
