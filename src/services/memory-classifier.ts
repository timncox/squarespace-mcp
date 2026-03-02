/**
 * Memory classifier — detects memory triggers in messages and classifies
 * them into categories using an LLM call.
 */

import { getAnthropicClient } from '../utils/anthropic-client.js';
import { MODEL_HAIKU } from '../config/models.js';
import { loadSitesConfig } from './task-extractor.js';
import { logger } from '../utils/logger.js';
import { errMsg } from '../utils/errors.js';
import type { MemoryCategory } from '../db/memories.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ClassifiedMemory {
  content: string;
  category: MemoryCategory;
  siteId?: string;
  tags?: string[];
}

// ─── Trigger Detection ──────────────────────────────────────────────────────

const MEMORY_TRIGGERS = [
  /\bremember\s*(that|this|:)/i,
  /\bkeep\s+in\s+mind/i,
  /\bdon'?t\s+forget/i,
  /^always\b/i,
  /^never\b/i,
];

const FORGET_TRIGGERS = [
  /(?<!\bdon'?t\s)\bforget\s+(that|about|the)/i,
  /\bstop\s+remembering/i,
  /\bremove\s+(that\s+)?memory/i,
];

const LIST_TRIGGERS = [
  /\bwhat\s+do\s+you\s+remember/i,
  /\bwhat\s+do\s+you\s+know\s+about/i,
  /\blist\s+memories/i,
  /\bshow\s+memories/i,
];

export function isMemoryTrigger(text: string): boolean {
  if (text.length < 10) return false;
  if (isForgetTrigger(text)) return false;
  return MEMORY_TRIGGERS.some((re) => re.test(text));
}

export function isForgetTrigger(text: string): boolean {
  return FORGET_TRIGGERS.some((re) => re.test(text));
}

export function isListMemoriesTrigger(text: string): boolean {
  return LIST_TRIGGERS.some((re) => re.test(text));
}

// ─── LLM Classification ────────────────────────────────────────────────────

export async function classifyMemory(memoryText: string): Promise<ClassifiedMemory> {
  const sitesConfig = loadSitesConfig();
  const siteNames = sitesConfig.clients.map((c: { name: string; id: string; aliases?: string[] }) => ({
    name: c.name,
    id: c.id,
    aliases: c.aliases,
  }));

  const response = await getAnthropicClient().messages.create({
    model: MODEL_HAIKU,
    max_tokens: 512,
    system: `You classify user preferences/rules for a Squarespace website management system.

Given a statement from the user, extract:
1. "content" — the core rule/preference (clean, concise, imperative)
2. "category" — one of: "client_preference" (tone, style, branding), "site_rule" (do/don't do on specific site), "workflow_shortcut" (shorthand definitions), "general" (applies everywhere)
3. "siteId" — the site subdomain if a specific site is mentioned, null if global
4. "tags" — 1-3 relevant tags (e.g., ["design", "theme"], ["menu", "pricing"])

Available sites: ${JSON.stringify(siteNames)}

Respond with JSON only, no markdown.`,
    messages: [{ role: 'user', content: memoryText }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  const text = textBlock?.type === 'text' ? textBlock.text : '{}';

  try {
    const parsed = JSON.parse(text.trim());
    return {
      content: parsed.content || memoryText,
      category: parsed.category || 'general',
      siteId: parsed.siteId || undefined,
      tags: Array.isArray(parsed.tags) ? parsed.tags : undefined,
    };
  } catch (err) {
    logger.warn({ error: errMsg(err), response: text }, 'Failed to parse memory classification — using defaults');
    return {
      content: memoryText,
      category: 'general',
    };
  }
}

export async function matchMemoryForForget(
  forgetText: string,
  memories: Array<{ id: string; content: string; siteId?: string }>,
): Promise<string | undefined> {
  if (memories.length === 0) return undefined;

  const memoryList = memories.map((m, i) => `${i}. "${m.content}" (site: ${m.siteId || 'global'})`).join('\n');

  const response = await getAnthropicClient().messages.create({
    model: MODEL_HAIKU,
    max_tokens: 64,
    system: `The user wants to forget a previously saved memory. Match their request to one of the existing memories below. Respond with ONLY the index number (0-based) of the best match, or "none" if nothing matches.

Existing memories:
${memoryList}`,
    messages: [{ role: 'user', content: forgetText }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  const text = (textBlock?.type === 'text' ? textBlock.text : '').trim();

  if (text === 'none') return undefined;

  const index = parseInt(text, 10);
  if (isNaN(index) || index < 0 || index >= memories.length) return undefined;

  return memories[index].id;
}
