/**
 * Site Analyst Agent — takes a screenshot of the current page and describes
 * the visual style, tone, layout, and existing content sections.
 *
 * This gives the Content Strategist context to draft content that matches the site.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import type { Page } from 'playwright';
import type { AgentResult, SiteAnalysis } from './types.js';
import { logger } from '../utils/logger.js';
import { getAnthropicClient } from '../utils/anthropic-client.js';
import { MODEL_SONNET } from '../config/models.js';
import { errMsg } from '../utils/errors.js';

/**
 * Analyze the current state of a Squarespace page.
 *
 * @param page — Playwright page object (should already be navigated to the target page)
 * @param screenshotPath — Where to save the screenshot
 * @param siteName — The restaurant/business name
 * @param pageName — Which page we're looking at (e.g., "home", "menus")
 */
export async function runSiteAnalystAgent(
  page: Page,
  screenshotPath: string,
  siteName: string,
  pageName: string,
): Promise<AgentResult<SiteAnalysis>> {
  const start = Date.now();

  try {
    // Take a screenshot of the current page
    await page.screenshot({ path: screenshotPath, fullPage: false, type: 'jpeg', quality: 60 });
    logger.info({ screenshotPath, pageName }, 'Site analyst: screenshot taken');

    // Read screenshot as base64
    const screenshotBuffer = readFileSync(screenshotPath);
    const base64 = screenshotBuffer.toString('base64');

    // Send to Claude for analysis
    const response = await getAnthropicClient().messages.create({
      model: MODEL_SONNET,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: base64 },
            },
            {
              type: 'text',
              text: buildAnalysisPrompt(siteName, pageName),
            },
          ],
        },
      ],
    });

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const analysis = parseAnalysisResponse(text, screenshotPath);

    logger.info(
      { brandTone: analysis.brandTone, sectionCount: analysis.existingSections.length },
      'Site analyst: analysis complete',
    );

    return {
      success: true,
      data: analysis,
      tokenUsage: { inputTokens, outputTokens },
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const errorMessage = errMsg(err);
    logger.error({ error: errorMessage }, 'Site analyst agent failed');
    return {
      success: false,
      error: errorMessage,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      durationMs: Date.now() - start,
    };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildAnalysisPrompt(siteName: string, pageName: string): string {
  return `You are a web design analyst helping a content strategist understand a website.

This is a screenshot of the "${pageName}" page of "${siteName}".

Analyze the page and describe:
1. **Visual style** — Is it minimalist, ornate, rustic, modern, etc.?
2. **Brand tone** — Upscale, casual, family-friendly, trendy, refined, corporate, creative, etc.?
3. **Existing sections** — List each content section visible on the page from top to bottom (hero image, welcome text, about section, services, CTA, footer, etc.)
4. **Visual notes** — What fonts seem to be used (serif, sans-serif, script)? What color palette? Light or dark theme? How much whitespace?

Respond with JSON:
{
  "styleDescription": "Minimalist modern design with large hero imagery and clean typography",
  "brandTone": "upscale casual",
  "existingSections": ["hero image with overlay text", "welcome paragraph", "services grid", "call to action", "footer with contact info"],
  "visualNotes": "Sans-serif headings, serif body text, dark/moody color palette with warm accent colors, generous whitespace between sections"
}`;
}

function parseAnalysisResponse(text: string, screenshotPath: string): SiteAnalysis {
  try {
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : text;
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    return {
      screenshotPath,
      styleDescription: (parsed.styleDescription as string) ?? 'Unknown style',
      existingSections: Array.isArray(parsed.existingSections)
        ? (parsed.existingSections as string[])
        : [],
      brandTone: (parsed.brandTone as string) ?? 'unknown',
      visualNotes: (parsed.visualNotes as string) ?? '',
    };
  } catch {
    logger.warn('Site analyst: could not parse analysis response as JSON — using raw text');
    return {
      screenshotPath,
      styleDescription: text.substring(0, 200),
      existingSections: [],
      brandTone: 'unknown',
      visualNotes: text,
    };
  }
}
