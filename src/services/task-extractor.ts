import { readFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import type { ParsedEmail } from './email-parser.js';
import type { TaskType } from '../models/task.js';
import type { SitesConfig } from '../models/site-config.js';
import { getAnthropicClient } from '../utils/anthropic-client.js';
import { MODEL_SONNET } from '../config/models.js';

export interface ExtractedTask {
  taskType: TaskType;
  clientName: string;
  siteIdentifier: string;
  targetPage?: string;
  contentToFind?: string;
  contentToAdd?: string;
  attachmentFilename?: string;
  applyToAllSites: boolean;
  groupId?: string;
  needsClarification: boolean;
  clarificationQuestion?: string;
  summary: string;
  /** Detailed description for the browser agent — what exactly to do on the page */
  description?: string;
}

export interface ExtractionResult {
  tasks: ExtractedTask[];
  reasoning: string;
}

/**
 * Use Claude to extract structured tasks from a parsed email.
 *
 * Claude receives:
 * - The email content (subject, body, sender info, attachment names)
 * - The site configuration (known clients, aliases, page structures)
 *
 * Claude returns a JSON array of tasks with task types, target sites/pages,
 * and content descriptions.
 */
export async function extractTasks(email: ParsedEmail): Promise<ExtractionResult> {
  // Load site config for context
  const sitesConfig = loadSitesConfig();

  const systemPrompt = buildSystemPrompt(sitesConfig);
  const userMessage = buildUserMessage(email);

  logger.info(
    { subject: email.subject, sender: email.originalSenderEmail || email.forwarderEmail },
    'Extracting tasks from email',
  );

  const response = await getAnthropicClient().messages.create({
    model: MODEL_SONNET,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  // Extract text response
  const textBlock = response.content.find((b) => b.type === 'text');
  const responseText = textBlock?.type === 'text' ? textBlock.text : '';

  // Parse JSON from response
  const result = parseExtractionResponse(responseText);

  logger.info(
    { taskCount: result.tasks.length, reasoning: result.reasoning.substring(0, 200) },
    'Tasks extracted',
  );

  return result;
}

// ─── Prompt Building ────────────────────────────────────────────────────────

function buildSystemPrompt(sitesConfig: SitesConfig): string {
  const clientList = sitesConfig.clients
    .map((c) => {
      const aliases = c.aliases.join(', ');
      const pages = c.site.pages.map((p) => `${p.title} (/${p.slug})`).join(', ');
      const emails = c.contactEmails.join(', ');
      return `- ${c.name} (id: "${c.id}", aliases: [${aliases}], emails: [${emails}], group: "${c.group || 'none'}")\n  Pages: ${pages}`;
    })
    .join('\n');

  const groupList = sitesConfig.groups
    .map((g) => {
      const aliases = g.aliases.join(', ');
      const sites = g.sites.join(', ');
      return `- ${g.name} (id: "${g.id}", aliases: [${aliases}])\n  Sites: ${sites}`;
    })
    .join('\n');

  return `You are a task extraction agent for a Squarespace website management service.

Your job is to read forwarded client emails and extract structured tasks that need to be performed on their Squarespace websites.

## Known Clients
${clientList}

## Groups (multiple sites)
${groupList}

## Task Types
- "remove_content" — Find and remove specific content from a page (e.g., "remove happy hour specials", "take down restaurant week menu")
- "add_content" — Add text or content to a page. Also use for gallery/image upload requests: when a client wants to add photos, create a gallery, add a portfolio section, or upload images to a page, use "add_content" and describe the gallery/image intent in the description.
- "upload_file_and_link" — Upload a PDF/image and create or update a link/button to it
- "update_menu_block" — Update the menu block with new items (from text or PDF). The content will be merged with existing menu content at execution time, so contentToAdd should contain the raw update content. For COMPLETE menu replacements (all tabs/sections provided), include the full formatted content — the merger handles both partial updates and full replacements.
- "replace_file" — Replace an existing uploaded file with a new version

## Instructions
1. Read the email carefully. The email may contain multiple tasks.
2. Match the sender or content to a known client. Use aliases and contact emails.
3. If the email says "all sites" or "all restaurants", set applyToAllSites=true and provide the group ID.
4. For each task, determine the most likely target page based on the content type and available pages.
5. If something is unclear, set needsClarification=true and provide a clarificationQuestion.
6. Always provide a brief human-readable summary for each task.
7. Always provide a "description" field with a clear, step-by-step instruction of what a browser agent should do on the Squarespace page to accomplish this task. Be specific about what to look for, click, type, or upload.
8. The agent can also work with sites NOT in the known clients list. If the email references a site by name or subdomain that isn't listed, use that name/subdomain as the siteIdentifier. Do NOT mark it as needing clarification just because it isn't in the known list — the system will discover it from the Squarespace account dashboard.
9. When PDF content is provided (under "## PDF Content"), use that text to populate contentToAdd. For menu PDFs, pass the raw PDF text as contentToAdd — the menu merger will handle formatting and merging with existing content at execution time. For COMPLETE menu replacements (all tabs provided), you may format the content, but it's not required. The description should instruct the browser agent to use editMenuBlock with merge: true.
10. For gallery/photo requests (client wants to add photos, create a gallery page, upload images, create a portfolio): use taskType "add_content", describe the gallery intent clearly in the description (mention "gallery", "photo gallery", or "portfolio" so the content pipeline can detect it), and set targetPage to the relevant page. If the email mentions specific images or attachments for a gallery, note them in the description. The content planning pipeline will handle gallery creation via the blank_api strategy with gallery blocks.

## Response Format
Respond with JSON only, in this exact format:
\`\`\`json
{
  "reasoning": "Brief explanation of how you interpreted the email",
  "tasks": [
    {
      "taskType": "remove_content",
      "clientName": "Smyth Tavern",
      "siteIdentifier": "smyth-tavern",
      "targetPage": "menus",
      "contentToFind": "Restaurant Week",
      "contentToAdd": null,
      "attachmentFilename": null,
      "applyToAllSites": false,
      "groupId": null,
      "needsClarification": false,
      "clarificationQuestion": null,
      "summary": "Remove Restaurant Week menu from Smyth Tavern's Menus page",
      "description": "On the Menus page, find the section containing 'Restaurant Week' text and remove the entire section."
    }
  ]
}
\`\`\``;
}

function buildUserMessage(email: ParsedEmail): string {
  const parts: string[] = [];

  parts.push(`## Email Details`);
  parts.push(`Subject: ${email.subject}`);
  parts.push(`From: ${email.forwarderName || email.forwarderEmail}`);
  if (email.originalSenderEmail) {
    parts.push(`Original sender: ${email.originalSenderName || ''} <${email.originalSenderEmail}>`);
  }
  parts.push(`Date: ${email.receivedAt}`);
  parts.push('');

  if (email.attachments.length > 0) {
    parts.push('## Attachments');
    for (const att of email.attachments) {
      parts.push(`- ${att.filename} (${att.mimeType}, ${Math.round(att.size / 1024)}KB)`);
    }
    parts.push('');

    // Include extracted PDF text content
    if (email.pdfTexts && Object.keys(email.pdfTexts).length > 0) {
      parts.push('## PDF Content (extracted text)');
      for (const [filename, { text, numPages }] of Object.entries(email.pdfTexts)) {
        parts.push(`### ${filename} (${numPages} page${numPages !== 1 ? 's' : ''})`);
        parts.push(text);
        parts.push('');
      }
    }
  }

  parts.push('## Email Body');
  parts.push(email.bodyText || '(no text body)');

  return parts.join('\n');
}

// ─── Response Parsing ───────────────────────────────────────────────────────

function parseExtractionResponse(responseText: string): ExtractionResult {
  // Try to extract JSON from the response
  // Claude might wrap it in ```json ... ``` or return it directly
  let jsonStr = responseText;

  const jsonBlockMatch = responseText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonBlockMatch) {
    jsonStr = jsonBlockMatch[1];
  }

  try {
    const parsed = JSON.parse(jsonStr.trim());

    if (!parsed.tasks || !Array.isArray(parsed.tasks)) {
      throw new Error('Response missing "tasks" array');
    }

    const tasks: ExtractedTask[] = parsed.tasks.map((t: Record<string, unknown>) => ({
      taskType: (t.taskType as TaskType) || 'remove_content',
      clientName: (t.clientName as string) || 'Unknown',
      siteIdentifier: (t.siteIdentifier as string) || 'unknown',
      targetPage: (t.targetPage as string) || undefined,
      contentToFind: (t.contentToFind as string) || undefined,
      contentToAdd: (t.contentToAdd as string) || undefined,
      attachmentFilename: (t.attachmentFilename as string) || undefined,
      applyToAllSites: (t.applyToAllSites as boolean) || false,
      groupId: (t.groupId as string) || undefined,
      needsClarification: (t.needsClarification as boolean) || false,
      clarificationQuestion: (t.clarificationQuestion as string) || undefined,
      summary: (t.summary as string) || 'Unknown task',
      description: (t.description as string) || undefined,
    }));

    return {
      tasks,
      reasoning: (parsed.reasoning as string) || '',
    };
  } catch (err) {
    logger.error({ error: err, responseText: responseText.substring(0, 500) }, 'Failed to parse task extraction response');
    return {
      tasks: [],
      reasoning: `Failed to parse response: ${err}`,
    };
  }
}

export function loadSitesConfig(): SitesConfig {
  const configPath = join(process.cwd(), 'config', 'sites.json');
  const raw = readFileSync(configPath, 'utf-8');
  return JSON.parse(raw) as SitesConfig;
}
