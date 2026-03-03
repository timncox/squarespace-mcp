/**
 * MCP Agent Orchestrator — full pipeline: classify → research → analyze → strategize → execute → supervise.
 *
 * Routes all tasks through autonomous Claude CLI agents backed by MCP tools.
 */

import { runAgent, type AgentConfig } from './cli-runner.js';
import { parseBrowserFallbacks, logBrowserFallback, type BrowserFallback } from './fallback-tracker.js';
import { dashboardEvents } from '../services/dashboard-events.js';
import { logger } from '../utils/logger.js';
import { errMsg } from '../utils/errors.js';
import type { Task } from '../models/task.js';
import type { Conversation } from '../models/conversation.js';
import type { ContentPlan } from '../agents/types.js';
import { createPlanOperations, type PlanOperation } from '../db/plan-operations.js';
import { join } from 'path';

// ── Agent Configs ───────────────────────────────────────────────────────────

const MCP_CONFIG = join(process.cwd(), 'mcp-config.json');
const PROMPTS_DIR = join(process.cwd(), 'src', 'orchestrator', 'prompts');

const AGENT_CONFIGS: Record<string, Omit<AgentConfig, 'mcpConfig'>> = {
  classifier: {
    name: 'classifier',
    model: 'haiku',
    maxTurns: 1,
    systemPromptFile: join(PROMPTS_DIR, 'classifier.md'),
  },
  researcher: {
    name: 'researcher',
    model: 'haiku',
    maxTurns: 5,
    systemPromptFile: join(PROMPTS_DIR, 'researcher.md'),
    allowedTools: [
      'mcp__squarespace__sq_web_search',
      'mcp__squarespace__sq_fetch_url',
    ],
  },
  analyst: {
    name: 'analyst',
    model: 'sonnet',
    maxTurns: 3,
    systemPromptFile: join(PROMPTS_DIR, 'analyst.md'),
    allowedTools: [
      'mcp__squarespace__sq_read_page',
      'mcp__squarespace__sq_list_pages',
      'mcp__squarespace__sq_get_navigation',
      'mcp__squarespace__sq_get_settings',
      'mcp__squarespace__sq_get_design',
      'mcp__squarespace__sq_take_screenshot',
    ],
  },
  strategist: {
    name: 'strategist',
    model: 'sonnet',
    maxTurns: 3,
    systemPromptFile: join(PROMPTS_DIR, 'strategist.md'),
    allowedTools: [
      'mcp__squarespace__sq_read_page',
      'mcp__squarespace__sq_list_pages',
      'mcp__squarespace__sq_get_navigation',
      'mcp__squarespace__sq_get_design',
    ],
  },
  executor: {
    name: 'executor',
    model: 'sonnet',
    maxTurns: 30,
    systemPromptFile: join(PROMPTS_DIR, 'executor.md'),
    allowedTools: ['mcp__squarespace__sq_*'],
  },
  supervisor: {
    name: 'supervisor',
    model: 'sonnet',
    maxTurns: 5,
    systemPromptFile: join(PROMPTS_DIR, 'supervisor.md'),
    allowedTools: [
      'mcp__squarespace__sq_read_page',
      'mcp__squarespace__sq_list_pages',
      'mcp__squarespace__sq_get_navigation',
      'mcp__squarespace__sq_get_settings',
      'mcp__squarespace__sq_get_design',
      'mcp__squarespace__sq_take_screenshot',
      'mcp__squarespace__sq_get_code_injection',
      'mcp__squarespace__sq_get_menu',
    ],
  },
};

// ── Types ───────────────────────────────────────────────────────────────────

export interface OrchestratorResult {
  success: boolean;
  verdict?: { verdict: string; issues: string[]; suggestions: string[] };
  fallbacks: BrowserFallback[];
  agentCosts: Record<string, number>;
  totalCost: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function agentConfig(name: string): AgentConfig {
  const base = AGENT_CONFIGS[name];
  if (!base) throw new Error(`Unknown agent: ${name}`);
  return { ...base, mcpConfig: MCP_CONFIG };
}

function emitActivity(taskId: string, agent: string, status: string) {
  dashboardEvents.emit('agent_activity', {
    taskId,
    agent,
    status,
    timestamp: new Date().toISOString(),
  });
}

// ── Classify ────────────────────────────────────────────────────────────────

export async function classifyTask(task: Task): Promise<{ route: 'simple' | 'pipeline'; simpleEditType?: string }> {
  const input = `Classify this Squarespace editing task:\n\nSite: ${task.siteId}\nTask: ${task.description}`;

  try {
    const result = await runAgent(agentConfig('classifier'), input, { timeout: 30_000 });
    const parsed = JSON.parse(result.text);

    if (parsed.route === 'simple' && parsed.confidence !== 'low') {
      return { route: 'simple', simpleEditType: parsed.simpleEditType };
    }
    return { route: 'pipeline' };
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'Classifier failed, defaulting to pipeline');
    return { route: 'pipeline' };
  }
}

// ── Pipeline ────────────────────────────────────────────────────────────────

export async function orchestrateTask(
  task: Task,
  conversation: Conversation,
): Promise<OrchestratorResult> {
  const agentCosts: Record<string, number> = {};
  const taskId = task.id;

  // 1. Classify
  emitActivity(taskId, 'classifier', 'started');
  const classification = await classifyTask(task);
  emitActivity(taskId, 'classifier', 'completed');

  if (classification.route === 'simple') {
    logger.info({ taskId, type: classification.simpleEditType }, 'Simple edit detected (MCP pipeline not yet wired to fast path)');
  }

  // 2. Research (if task mentions URLs or needs external content)
  let research = '';
  const needsResearch = /https?:\/\/|research|look up|find out|what are/i.test(task.description ?? '');
  if (needsResearch) {
    emitActivity(taskId, 'researcher', 'started');
    try {
      const result = await runAgent(agentConfig('researcher'), task.description ?? '', {
        timeout: 60_000,
        onStep: (step) => dashboardEvents.emit('agent_step', { taskId, ...step }),
      });
      research = result.text;
      agentCosts.researcher = result.cost;
    } catch (err) {
      logger.warn({ error: errMsg(err) }, 'Researcher failed, continuing without research');
    }
    emitActivity(taskId, 'researcher', 'completed');
  }

  // 3. Analyze
  emitActivity(taskId, 'analyst', 'started');
  let analysis = '';
  try {
    const input = `Analyze site "${task.siteId}" for this task: ${task.description}\nTarget page: ${task.targetPage ?? 'home'}`;
    const result = await runAgent(agentConfig('analyst'), input, {
      timeout: 120_000,
      onStep: (step) => dashboardEvents.emit('agent_step', { taskId, ...step }),
    });
    analysis = result.text;
    agentCosts.analyst = result.cost;
  } catch (err) {
    logger.error({ error: errMsg(err) }, 'Analyst failed');
    return { success: false, fallbacks: [], agentCosts, totalCost: sumCosts(agentCosts) };
  }
  emitActivity(taskId, 'analyst', 'completed');

  // 4. Strategize
  emitActivity(taskId, 'strategist', 'started');
  let plan = '';
  try {
    const input = [
      `Task: ${task.description}`,
      `Site: ${task.siteId}`,
      `Target page: ${task.targetPage ?? 'home'}`,
      `\n## Current Site Analysis\n${analysis}`,
      research ? `\n## Research Findings\n${research}` : '',
    ].join('\n');
    const result = await runAgent(agentConfig('strategist'), input, {
      timeout: 120_000,
      onStep: (step) => dashboardEvents.emit('agent_step', { taskId, ...step }),
    });
    plan = result.text;
    agentCosts.strategist = result.cost;
  } catch (err) {
    logger.error({ error: errMsg(err) }, 'Strategist failed');
    return { success: false, fallbacks: [], agentCosts, totalCost: sumCosts(agentCosts) };
  }
  emitActivity(taskId, 'strategist', 'completed');

  // 4b. Parse ContentPlan JSON
  let contentPlan: ContentPlan;
  try {
    contentPlan = JSON.parse(plan);
  } catch {
    logger.error({ raw: plan.substring(0, 500) }, 'Strategist returned invalid JSON');
    return { success: false, fallbacks: [], agentCosts, totalCost: sumCosts(agentCosts) };
  }

  // 4c. Track operations in DB
  let trackedOps: PlanOperation[] = [];
  try {
    trackedOps = createPlanOperations(conversation.id, contentPlan);
    for (const op of trackedOps) {
      dashboardEvents.emit('operation_update', {
        conversationId: conversation.id,
        operationId: op.id,
        status: 'pending',
        description: `${op.operationType} on ${op.targetPage ?? 'site'}`,
      });
    }
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'Failed to track operations (non-blocking)');
  }

  logger.info({
    taskId,
    operationCount: contentPlan.operations.length,
    trackedOps: trackedOps.length,
  }, 'ContentPlan parsed and tracked');

  // 4d. Optional plan approval gate
  if (process.env.REQUIRE_PLAN_APPROVAL === 'true') {
    const planSummary = contentPlan.operations
      .map((op, i) => `${i + 1}. [${op.operationType}] ${op.placement} (${op.targetPage})`)
      .join('\n');

    // Dynamic imports to avoid circular dependencies (established pattern)
    const { sendButtonsToTim } = await import('../services/whatsapp.js');
    const { updateConversationStatus } = await import('../db/conversations.js');

    await sendButtonsToTim(
      `Here's my plan:\n\n${planSummary}\n\nShall I proceed?`,
      [
        { id: 'confirm_yes', title: 'Yes, proceed' },
        { id: 'confirm_no', title: 'No, cancel' },
      ],
      conversation.id,
    );
    updateConversationStatus(conversation.id, 'awaiting_plan_approval');

    return { success: true, verdict: undefined, fallbacks: [], agentCosts, totalCost: sumCosts(agentCosts) };
  }

  // 5. Execute
  emitActivity(taskId, 'executor', 'started');
  let executorOutput = '';
  try {
    const input = [
      `Site: ${task.siteId}`,
      `Target page: ${task.targetPage ?? 'home'}`,
      `\n## Plan (ContentPlan JSON)\n\`\`\`json\n${JSON.stringify(contentPlan, null, 2)}\n\`\`\``,
    ].join('\n');
    const result = await runAgent(agentConfig('executor'), input, {
      timeout: 300_000,
      onStep: (step) => dashboardEvents.emit('agent_step', { taskId, ...step }),
    });
    executorOutput = result.text;
    agentCosts.executor = result.cost;
  } catch (err) {
    logger.error({ error: errMsg(err) }, 'Executor failed');
    return { success: false, fallbacks: [], agentCosts, totalCost: sumCosts(agentCosts) };
  }
  emitActivity(taskId, 'executor', 'completed');

  // 6. Track browser fallbacks
  const fallbacks = parseBrowserFallbacks(executorOutput);
  for (const fb of fallbacks) {
    logBrowserFallback(task.siteId, task.targetPage ?? null, fb, taskId);
  }

  // 7. Supervise
  emitActivity(taskId, 'supervisor', 'started');
  let verdict: OrchestratorResult['verdict'] | undefined;
  try {
    const input = [
      `Task: ${task.description}`,
      `Site: ${task.siteId}`,
      `Target page: ${task.targetPage ?? 'home'}`,
      `\n## ContentPlan\n\`\`\`json\n${JSON.stringify(contentPlan, null, 2)}\n\`\`\``,
      `\n## Executor Result\n${executorOutput}`,
    ].join('\n');
    const result = await runAgent(agentConfig('supervisor'), input, {
      timeout: 120_000,
      onStep: (step) => dashboardEvents.emit('agent_step', { taskId, ...step }),
    });
    try {
      verdict = JSON.parse(result.text);
    } catch {
      verdict = { verdict: 'unknown', issues: ['Could not parse supervisor output'], suggestions: [] };
    }
    agentCosts.supervisor = result.cost;
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'Supervisor failed, treating as unverified');
  }
  emitActivity(taskId, 'supervisor', 'completed');

  const totalCost = sumCosts(agentCosts);
  const success = verdict?.verdict === 'pass' || verdict?.verdict === 'partial';

  logger.info({
    taskId,
    verdict: verdict?.verdict,
    fallbackCount: fallbacks.length,
    totalCost,
    agentCosts,
  }, 'MCP orchestration complete');

  return { success, verdict, fallbacks, agentCosts, totalCost };
}

function sumCosts(costs: Record<string, number>): number {
  return Object.values(costs).reduce((a, b) => a + b, 0);
}
