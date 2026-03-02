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
import type { Task } from '../../models/task.js';
import type { Conversation } from '../../models/conversation.js';

const mockRunAgent = vi.mocked(runAgent);
const mockParseFallbacks = vi.mocked(parseBrowserFallbacks);
const mockLogFallback = vi.mocked(logBrowserFallback);
const mockEmit = vi.mocked(dashboardEvents.emit);

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

describe('orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      // strategist
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Update heading in section 1', 0.03));
      // executor
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Heading updated to new text', 0.05));
      // supervisor
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ verdict: 'pass', issues: [], suggestions: [] }), 0.02),
      );

      const result = await orchestrateTask(makeTask(), makeConversation());

      expect(result.success).toBe(true);
      expect(result.verdict?.verdict).toBe('pass');
      expect(result.totalCost).toBeCloseTo(0.12, 5); // analyst + strategist + executor + supervisor (classifier not tracked)
      expect(result.agentCosts.analyst).toBe(0.02);
      expect(result.agentCosts.strategist).toBe(0.03);
      expect(result.agentCosts.executor).toBe(0.05);
      expect(result.agentCosts.supervisor).toBe(0.02);
    });

    it('should skip research when not needed', async () => {
      // classifier
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ route: 'pipeline' })),
      );
      // analyst
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Analysis'));
      // strategist
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Plan'));
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
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Plan'));
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
      // Only classifier ran (no cost tracked for it since it doesn't store in agentCosts)
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

    it('should abort pipeline on executor failure', async () => {
      // classifier
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ route: 'pipeline' })),
      );
      // analyst
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Analysis', 0.02));
      // strategist
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Plan', 0.03));
      // executor fails
      mockRunAgent.mockRejectedValueOnce(new Error('Executor timeout'));

      const result = await orchestrateTask(makeTask(), makeConversation());

      expect(result.success).toBe(false);
      expect(result.agentCosts.analyst).toBe(0.02);
      expect(result.agentCosts.strategist).toBe(0.03);
      expect(result.totalCost).toBe(0.05);
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
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Plan'));
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
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Plan'));
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
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Plan'));
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
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Plan'));
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
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Plan', 0.03));
      // executor
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Done', 0.05));
      // supervisor
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ verdict: 'pass', issues: [], suggestions: [] }), 0.015),
      );

      const result = await orchestrateTask(makeTask(), makeConversation());

      // Note: classifier cost is not tracked in agentCosts (only research through supervisor)
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
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Plan'));
      // executor
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Done'));
      // supervisor
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ verdict: 'pass', issues: [], suggestions: [] })),
      );

      await orchestrateTask(makeTask(), makeConversation());

      // Each agent gets started + completed = 2 events each
      // classifier, analyst, strategist, executor, supervisor = 5 agents × 2 = 10 events
      const activityCalls = mockEmit.mock.calls.filter(([type]) => type === 'agent_activity');
      expect(activityCalls.length).toBe(10);

      // Verify ordering: classifier started first
      expect(activityCalls[0][1]).toMatchObject({ agent: 'classifier', status: 'started' });
      expect(activityCalls[1][1]).toMatchObject({ agent: 'classifier', status: 'completed' });
    });

    it('should handle task with no description gracefully', async () => {
      // classifier
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ route: 'pipeline' })),
      );
      // analyst
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Analysis'));
      // strategist
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Plan'));
      // executor
      mockRunAgent.mockResolvedValueOnce(mockAgentResult('Done'));
      // supervisor
      mockRunAgent.mockResolvedValueOnce(
        mockAgentResult(JSON.stringify({ verdict: 'pass', issues: [], suggestions: [] })),
      );

      const task = makeTask({ description: undefined });
      const result = await orchestrateTask(task, makeConversation());

      // Should not crash — uses empty string fallback
      expect(result.success).toBe(true);
    });
  });
});
