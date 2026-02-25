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
import type { ContentPlan, ContentOperation, ResearchResult, SiteAnalysis, PageStructure, BlockSummary, SectionSummary } from './types.js';
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
  let pageStructures: Record<string, PageStructure> | undefined;
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

    // ── Step 2b: Fetch page structure via Content Save API ──────────────
    // While the browser is still open on the target page, extract the actual
    // section/block JSON for the content strategist. This gives the strategist
    // precise knowledge of existing content instead of guessing from a screenshot.
    try {
      const structure = await fetchPageStructure(page, siteId);
      if (structure) {
        const key = `${siteId}:${targetPage}`;
        pageStructures = { [key]: structure };
        logger.info(
          { key, sectionCount: structure.sectionCount },
          'Content pipeline: page structure fetched',
        );
        dashboardEvents.emit('dashboard', {
          type: 'agent_activity' as const,
          data: { agent: 'page_structure', status: 'completed', message: `Page structure: ${structure.sectionCount} sections, ${structure.sections.reduce((s, sec) => s + sec.blockCount, 0)} blocks` },
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err) {
      logger.warn({ error: errMsg(err) }, 'Content pipeline: page structure fetch failed, continuing without');
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

  const strategyResult = await runContentStrategistAgent(tasks, research, siteAnalysis, undefined, undefined, undefined, pageStructures);

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

// ─── Page Structure Fetching ─────────────────────────────────────────────────

/**
 * Fetch page structure data via the Content Save API for the content strategist.
 *
 * Extracts the pageSectionsId from the browser page DOM (the `data-page-sections`
 * attribute on the `<article>` element), then calls `getPageSections()` to get
 * the actual section/block JSON. Returns a clean summary.
 *
 * Must be called while the browser is on the target page (admin panel with
 * sqs-site-frame iframe visible).
 *
 * @param page — Playwright page currently viewing the target page
 * @param siteId — Site subdomain (e.g., "smyth-tavern")
 * @returns PageStructure summary, or null if API call fails
 */
export async function fetchPageStructure(
  page: import('playwright').Page,
  siteId: string,
): Promise<PageStructure | null> {
  try {
    // Pre-flight: check session cookie health
    const { ContentSaveClient } = await import('../services/content-save.js');
    const health = ContentSaveClient.checkSessionHealth();
    if (!health.exists || !health.hasCrumb) {
      logger.warn(
        { exists: health.exists, hasCrumb: health.hasCrumb, ageHours: Math.round(health.ageHours) },
        'Page structure: session not healthy, skipping API fetch',
      );
      return null;
    }

    // Extract pageSectionsId from the editor DOM (sqs-site-frame iframe)
    const siteFrame = page.frame({ name: 'sqs-site-frame' });
    if (!siteFrame) {
      // Fallback: try the main frame (some admin views render the page directly)
      const pageSectionsId = await page.evaluate(() => {
        const article = document.querySelector('article[data-page-sections]');
        return article?.getAttribute('data-page-sections') ?? null;
      }).catch(() => null);

      if (!pageSectionsId) {
        logger.debug('Page structure: no sqs-site-frame and no data-page-sections in main frame');
        return null;
      }

      return await fetchAndSummarize(siteId, pageSectionsId);
    }

    const pageSectionsId = await siteFrame.evaluate(() => {
      const article = document.querySelector('article[data-page-sections]');
      return article?.getAttribute('data-page-sections') ?? null;
    }).catch(() => null);

    if (!pageSectionsId) {
      logger.debug('Page structure: could not find data-page-sections attribute in iframe');
      return null;
    }

    return await fetchAndSummarize(siteId, pageSectionsId);
  } catch (err) {
    logger.warn({ error: errMsg(err), siteId }, 'Page structure: failed to fetch');
    return null;
  }
}

/**
 * Internal helper: create a ContentSaveClient, fetch sections, and summarize.
 */
async function fetchAndSummarize(
  siteId: string,
  pageSectionsId: string,
): Promise<PageStructure | null> {
  const { createContentSaveClient } = await import('../services/content-save.js');
  const client = createContentSaveClient(siteId);
  const sectionsData = await client.getPageSections(pageSectionsId);

  if (!sectionsData.sections || sectionsData.sections.length === 0) {
    logger.info({ siteId, pageSectionsId }, 'Page structure: no sections found');
    return { sectionCount: 0, sections: [] };
  }

  const structure = summarizePageSections(sectionsData.sections);
  logger.info(
    { siteId, pageSectionsId, sectionCount: structure.sectionCount, totalBlocks: structure.sections.reduce((sum, s) => sum + s.blockCount, 0) },
    'Page structure: fetched successfully',
  );
  return structure;
}

/**
 * Convert raw Squarespace page sections data into a clean summary for the
 * content strategist prompt.
 *
 * This is a pure function (no side effects, no API calls) for easy testing.
 */
export function summarizePageSections(
  sections: import('../services/content-save.js').PageSection[],
): PageStructure {
  const TEXT_SNIPPET_LENGTH = 100;

  // Block type number → human-readable name
  const BLOCK_TYPE_NAMES: Record<number, string> = {
    2: 'text',
    1337: 'image',
    46: 'button',
    44: 'quote',
    23: 'code',
    51: 'video',
    55: 'form',
    52: 'gallery',
    54: 'line',
    42: 'embed',
    56: 'menu',
    71: 'summary',
  };

  const sectionSummaries: SectionSummary[] = sections.map((section, index) => {
    const blocks: BlockSummary[] = [];
    const gridContents = section.fluidEngineContext?.gridContents ?? [];

    for (const gc of gridContents) {
      const blockType = gc.content?.value?.type ?? 0;
      const typeName = BLOCK_TYPE_NAMES[blockType] ?? `unknown(${blockType})`;
      const blockValue = gc.content?.value?.value;

      const summary: BlockSummary = { type: typeName };

      if (blockType === 2 && blockValue) {
        // Text block: extract snippet from HTML source
        const html = (blockValue as { source?: string; html?: string }).source
          ?? (blockValue as { html?: string }).html
          ?? '';
        const stripped = stripHtml(html);
        if (stripped) {
          summary.textSnippet = stripped.length > TEXT_SNIPPET_LENGTH
            ? stripped.substring(0, TEXT_SNIPPET_LENGTH) + '...'
            : stripped;
        }
      } else if (blockType === 1337 && blockValue) {
        // Image block: extract alt text / title
        const imgVal = blockValue as { title?: string; description?: string; altText?: string };
        summary.imageAlt = imgVal.altText ?? imgVal.title ?? imgVal.description ?? undefined;
      } else if (blockValue) {
        // Button or other block with text/label
        const val = blockValue as { text?: string; label?: string };
        if (val.label) {
          summary.buttonLabel = val.label;
        }
        if (val.text) {
          summary.textSnippet = val.text.length > TEXT_SNIPPET_LENGTH
            ? val.text.substring(0, TEXT_SNIPPET_LENGTH) + '...'
            : val.text;
        }
      }

      blocks.push(summary);
    }

    return {
      id: section.id,
      index,
      name: section.sectionName ?? `Section ${index + 1}`,
      blockCount: gridContents.length,
      blocks,
    };
  });

  return {
    sectionCount: sections.length,
    sections: sectionSummaries,
  };
}

/**
 * Strip HTML tags to get plain text. Simple regex-based strip (no DOM parser needed).
 */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(?:p|h[1-6]|div|li|blockquote)>/gi, ' ')  // closing block tags → space
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
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
