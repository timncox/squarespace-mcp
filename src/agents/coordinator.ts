/**
 * Content Planning Coordinator — orchestrates the agent pipeline.
 *
 * Pipeline: Research Agent → Site Analyst → Content Strategist → ContentPlan
 *
 * Sends WhatsApp progress updates to Tim at each stage.
 * Returns a ContentPlan ready for Tim's approval.
 */

import type { Page } from 'playwright';
import type { Task } from '../models/task.js';
import type { Conversation } from '../models/conversation.js';
import type { ContentPlan, ContentOperation, ResearchResult, SiteAnalysis } from './types.js';
import { runResearchAgent } from './research-agent.js';
import { visitProjectUrls } from './url-researcher.js';
import { runSiteAnalystAgent } from './site-analyst-agent.js';
import { runContentStrategistAgent } from './content-strategist-agent.js';
import { getBrowserManager } from '../automation/browser-manager.js';
import { ensureLoggedIn } from '../automation/squarespace-auth.js';
import { resolveSite, navigateToSite, navigateToPage } from '../automation/site-navigator.js';
import { sendToTim } from '../services/whatsapp.js';
import { logger } from '../utils/logger.js';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { errMsg } from '../utils/errors.js';

const SCREENSHOTS_DIR = 'storage/screenshots';

/**
 * Run the full content planning pipeline for a set of tasks.
 *
 * 1. Research Agent — web search for external context
 * 2. Site Analyst — screenshot + analyze the target page
 * 3. Content Strategist — draft the content plan
 */
export async function runContentPipeline(
  conversation: Conversation,
  tasks: Task[],
  conversationId?: string,
): Promise<ContentPlan> {
  const convId = conversationId ?? conversation.id;
  const startTime = Date.now();

  // Get the primary task for context (use first task for site/page info)
  const primaryTask = tasks[0];
  if (!primaryTask) {
    throw new Error('No tasks to plan content for');
  }

  const siteName = primaryTask.clientName || 'the business';
  const siteId = primaryTask.siteId;
  const targetPage = primaryTask.targetPage ?? 'home';
  const taskDescription = primaryTask.description ?? 'General content update';

  logger.info(
    { conversationId: conversation.id, taskCount: tasks.length, siteId, targetPage },
    'Content pipeline: starting',
  );

  // Dynamic import for dashboard events (fire-and-forget, avoids circular deps)
  const { dashboardEvents } = await import('../services/dashboard-events.js');

  // ── Step 1: Research ──────────────────────────────────────────────────
  // Detect URLs in the task description — if found, visit them directly
  // instead of doing a generic Brave web search.
  const urlsInDescription = extractUrls(taskDescription);

  let research: ResearchResult | undefined;

  if (urlsInDescription.length > 0) {
    // URL Research: visit each project URL to get real titles/descriptions
    await sendToTim(`🔍 Visiting ${urlsInDescription.length} project URL(s)...`, convId);
    dashboardEvents.emit('dashboard', {
      type: 'agent_activity' as const,
      data: { agent: 'url_researcher', status: 'started', message: `Visiting ${urlsInDescription.length} project URL(s)...` },
      timestamp: new Date().toISOString(),
    });

    try {
      mkdirSync(SCREENSHOTS_DIR, { recursive: true });
      const urlResults = await visitProjectUrls(urlsInDescription, SCREENSHOTS_DIR);

      // Convert URL research results into the standard ResearchResult format
      // so the Content Strategist gets structured project info
      const findings = urlResults.map((r) =>
        `Project: "${r.title}" — ${r.description} | URL: ${r.url}${r.screenshotPath ? ` | Screenshot: ${r.screenshotPath}` : ''}`,
      );

      research = {
        queries: urlsInDescription,
        findings,
        sources: urlsInDescription,
        rawSnippets: findings,
      };

      logger.info(
        { urlCount: urlsInDescription.length, findings: findings.length },
        'Content pipeline: URL research complete',
      );
      dashboardEvents.emit('dashboard', {
        type: 'agent_activity' as const,
        data: { agent: 'url_researcher', status: 'completed', message: `Extracted metadata from ${urlsInDescription.length} URLs`, detail: { findings: findings.length } },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      logger.warn({ error: errMsg(err) }, 'Content pipeline: URL research failed, continuing');
      dashboardEvents.emit('dashboard', {
        type: 'agent_activity' as const,
        data: { agent: 'url_researcher', status: 'failed', message: 'URL research failed, continuing without' },
        timestamp: new Date().toISOString(),
      });
    }
  } else {
    // Standard research: Brave web search for external context
    await sendToTim('🔍 Researching...', convId);
    dashboardEvents.emit('dashboard', {
      type: 'agent_activity' as const,
      data: { agent: 'research', status: 'started', message: 'Web searching for external context...' },
      timestamp: new Date().toISOString(),
    });

    try {
      const researchResult = await runResearchAgent(taskDescription, siteName);
      if (researchResult.success && researchResult.data) {
        research = researchResult.data;
        const hasSynthesis = !!research.synthesis;
        const structuredPageCount = research.structuredPages?.length ?? 0;
        logger.info(
          {
            findings: research.findings.length,
            sources: research.sources.length,
            hasSynthesis,
            keyFacts: research.synthesis?.keyFacts.length ?? 0,
            structuredPages: structuredPageCount,
          },
          'Content pipeline: research complete',
        );
        const synthDetail = hasSynthesis
          ? `, ${research.synthesis!.keyFacts.length} key facts, ${research.synthesis!.contentSuggestions.length} content suggestions`
          : '';
        const pageDetail = structuredPageCount > 0 ? `, ${structuredPageCount} pages analyzed` : '';
        dashboardEvents.emit('dashboard', {
          type: 'agent_activity' as const,
          data: { agent: 'research', status: 'completed', message: `Found ${research.findings.length} findings from ${research.sources.length} sources${synthDetail}${pageDetail}` },
          timestamp: new Date().toISOString(),
        });
      } else {
        logger.warn({ error: researchResult.error }, 'Content pipeline: research failed, continuing without research');
        dashboardEvents.emit('dashboard', {
          type: 'agent_activity' as const,
          data: { agent: 'research', status: 'failed', message: 'Web research failed, continuing without' },
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err) {
      logger.warn({ error: errMsg(err) }, 'Content pipeline: research error, continuing');
    }
  }

  // ── Step 2: Site Analyst Agent ──────────────────────────────────────────
  await sendToTim('📸 Analyzing your site...', convId);
  dashboardEvents.emit('dashboard', {
    type: 'agent_activity' as const,
    data: { agent: 'site_analyst', status: 'started', message: `Analyzing ${targetPage} page design and layout...` },
    timestamp: new Date().toISOString(),
  });

  let siteAnalysis: SiteAnalysis | undefined;
  try {
    const browserManager = getBrowserManager({ headless: true });
    await ensureLoggedIn(browserManager);
    const page = await browserManager.getPage();

    // Navigate to the target page
    const client = await resolveSite(siteId, page);
    await navigateToSite(page, client);

    if (targetPage) {
      try {
        await navigateToPage(page, client, targetPage);
      } catch {
        logger.warn({ targetPage }, 'Content pipeline: could not navigate to target page, using landing page');
      }
    }

    // Take screenshot for analysis
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    const screenshotPath = join(
      SCREENSHOTS_DIR,
      `site-analysis-${conversation.id.substring(0, 8)}-${Date.now()}.jpg`,
    );

    const analysisResult = await runSiteAnalystAgent(page, screenshotPath, siteName, targetPage);
    if (analysisResult.success && analysisResult.data) {
      siteAnalysis = analysisResult.data;
      logger.info(
        { brandTone: siteAnalysis.brandTone, sections: siteAnalysis.existingSections.length },
        'Content pipeline: site analysis complete',
      );
      dashboardEvents.emit('dashboard', {
        type: 'agent_activity' as const,
        data: { agent: 'site_analyst', status: 'completed', message: `Analysis complete: ${siteAnalysis.brandTone}, ${siteAnalysis.existingSections.length} sections detected` },
        timestamp: new Date().toISOString(),
      });
    } else {
      logger.warn({ error: analysisResult.error }, 'Content pipeline: site analysis failed, continuing without');
      dashboardEvents.emit('dashboard', {
        type: 'agent_activity' as const,
        data: { agent: 'site_analyst', status: 'failed', message: 'Site analysis failed, continuing without' },
        timestamp: new Date().toISOString(),
      });
    }

    // Close the browser — the editor agent will open its own session later
    await browserManager.close();
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'Content pipeline: site analysis error, continuing');
  }

  // ── Step 3: Content Strategist Agent ────────────────────────────────────
  await sendToTim('✏️ Drafting content plan...', convId);
  dashboardEvents.emit('dashboard', {
    type: 'agent_activity' as const,
    data: { agent: 'content_strategist', status: 'started', message: 'Drafting content plan with exact copy and editor instructions...' },
    timestamp: new Date().toISOString(),
  });

  const strategyResult = await runContentStrategistAgent(tasks, research, siteAnalysis);

  if (!strategyResult.success || !strategyResult.data) {
    throw new Error(`Content strategist failed: ${strategyResult.error ?? 'Unknown error'}`);
  }

  let plan = strategyResult.data;

  // ── Safety net: expand operations from URL research if strategist underproduced ──
  // If URL research found N URLs but the strategist produced ≤ 1 operation
  // (typical of a JSON parse fallback), expand to N operations using research data.
  if (
    urlsInDescription.length > 1 &&
    plan.operations.length <= 1 &&
    research &&
    research.findings.length > 1
  ) {
    logger.warn(
      {
        urlCount: urlsInDescription.length,
        opCount: plan.operations.length,
        findingCount: research.findings.length,
      },
      'Content pipeline: strategist underproduced — expanding operations from URL research',
    );

    plan = expandPlanFromResearch(plan, research, primaryTask, urlsInDescription);

    logger.info(
      { expandedOpCount: plan.operations.length },
      'Content pipeline: operations expanded from URL research',
    );
  }

  dashboardEvents.emit('dashboard', {
    type: 'agent_activity' as const,
    data: { agent: 'content_strategist', status: 'completed', message: `Plan ready: ${plan.operations.length} operations, ~${plan.estimatedMinutes}min` },
    timestamp: new Date().toISOString(),
  });

  const durationSec = Math.round((Date.now() - startTime) / 1000);
  logger.info(
    {
      conversationId: conversation.id,
      operationCount: plan.operations.length,
      durationSec,
    },
    'Content pipeline: plan ready',
  );

  return plan;
}

/**
 * Revise an existing content plan based on Tim's feedback.
 * Re-runs only the Content Strategist with the feedback context.
 */
export async function reviseContentPlan(
  tasks: Task[],
  previousPlan: ContentPlan,
  feedback: string,
  research?: ResearchResult,
  siteAnalysis?: SiteAnalysis,
  conversationId?: string,
): Promise<ContentPlan> {
  logger.info({ feedback: feedback.substring(0, 100) }, 'Content pipeline: revising plan');

  await sendToTim('✏️ Revising the plan...', conversationId);

  const result = await runContentStrategistAgent(
    tasks,
    research,
    siteAnalysis,
    feedback,
    previousPlan,
  );

  if (!result.success || !result.data) {
    throw new Error(`Content strategist revision failed: ${result.error ?? 'Unknown error'}`);
  }

  return result.data;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract URLs from a task description.
 * Filters out Squarespace admin/config URLs (those are site targets, not project URLs).
 */
function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s,)]+/gi;
  const matches = text.match(urlRegex) ?? [];

  return matches
    .map((url) => url.replace(/[.,;]+$/, '')) // strip trailing punctuation
    .filter((url) => {
      // Exclude Squarespace admin URLs — those are site identifiers, not project URLs
      if (url.includes('squarespace.com')) return false;
      if (url.includes('/config/')) return false;
      return true;
    });
}

/**
 * Expand a failed/minimal plan into one operation per URL using research data.
 *
 * Called when the content strategist's JSON parsing failed and produced a single
 * fallback operation, but we have structured research findings for each URL.
 */
function expandPlanFromResearch(
  originalPlan: ContentPlan,
  research: ResearchResult,
  primaryTask: Task,
  urls: string[],
): ContentPlan {
  // Parse research findings into structured data
  // Findings format: `Project: "Title" — Description | URL: https://... | Screenshot: /path/to/file.png`
  const projectData = research.findings.map((finding) => {
    const titleMatch = finding.match(/Project:\s*"([^"]+)"/);
    const descMatch = finding.match(/—\s*(.+?)(?:\s*\|\s*URL:|$)/);
    const urlMatch = finding.match(/URL:\s*(https?:\/\/[^\s|]+)/);
    const screenshotMatch = finding.match(/Screenshot:\s*([^\s|]+)/);

    return {
      title: titleMatch?.[1] ?? 'Untitled Project',
      description: descMatch?.[1]?.trim() ?? 'A web project',
      url: urlMatch?.[1] ?? '',
      screenshotPath: screenshotMatch?.[1] ?? undefined,
    };
  });

  // If we couldn't parse research findings, try matching by URL order
  if (projectData.every((p) => !p.url)) {
    for (let i = 0; i < urls.length && i < projectData.length; i++) {
      projectData[i].url = urls[i];
    }
  }

  const operations: ContentOperation[] = projectData.map((project, idx) => {
    const hasScreenshot = !!project.screenshotPath;
    // Build editorInstruction with optional image block step
    const steps: string[] = [
      '1. Hover below the last section to reveal "Add Section". Click it.',
      '2. Click "+ Add Blank", then "Section" to add an empty section.',
      '3. Click "Edit Section" (pencil icon) on the new section.',
    ];
    let stepNum = 4;

    if (hasScreenshot) {
      steps.push(
        `${stepNum}. Use addImageBlock with imagePath='${project.screenshotPath}' and altText='${project.title} screenshot'.`,
      );
      stepNum++;
    }

    steps.push(
      `${stepNum}. Click "Add Block" (top-left corner). Search for "Text" and click it.`,
      `${stepNum + 1}. Double-click the new text block. Type "${project.title}".`,
      `${stepNum + 2}. Highlight the text, click the Format dropdown, select H2.`,
      `${stepNum + 3}. Press Enter. Type: "${project.description}". Click outside to save.`,
    );
    stepNum += 4;

    if (project.url) {
      steps.push(
        `${stepNum}. Click "Add Block" again. Search for "Button" and click it.`,
        `${stepNum + 1}. Double-click the button. Set label to "View Project". Click URL dropdown, paste ${project.url}. Click outside to save.`,
      );
      stepNum += 2;
    }

    steps.push(`${stepNum}. Click "Save" (top-right).`);

    return {
      taskId: primaryTask.id,
      siteId: primaryTask.siteId,
      targetPage: primaryTask.targetPage ?? 'home',
      operationType: 'add_section' as const,
      placement: idx === 0
        ? 'At the bottom of the existing content on the page'
        : 'Below the section just added',
      content: {
        heading: project.title,
        bodyText: project.description,
        button: project.url ? { label: 'View Project', url: project.url } : undefined,
        imagePath: project.screenshotPath,
        imageAltText: hasScreenshot ? `${project.title} screenshot` : undefined,
        blockType: 'text' as const,
      },
      editorInstruction: steps.join(' '),
    };
  });

  return {
    summary: `Add ${operations.length} project cards to the ${primaryTask.targetPage ?? 'home'} page: ${operations.slice(0, 4).map((o) => o.content.heading).join(', ')}${operations.length > 4 ? ` and ${operations.length - 4} more` : ''}`,
    operations,
    sources: urls,
    estimatedMinutes: Math.max(3, operations.length * 2),
  };
}
