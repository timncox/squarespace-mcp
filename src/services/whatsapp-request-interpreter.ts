import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../utils/logger.js';
import { loadSitesConfig } from './task-extractor.js';
import type { SitesConfig } from '../models/site-config.js';
import type { DiscoveredSite } from '../automation/site-discovery.js';
import { getAnthropicClient } from '../utils/anthropic-client.js';
import { MODEL_SONNET } from '../config/models.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface InterpretedTask {
  siteId: string;
  clientName: string;
  targetPage?: string;
  /** Natural language description of what the browser agent should do */
  description: string;
  applyToAllSites: boolean;
  groupId?: string;
  needsClarification: boolean;
  clarificationQuestion?: string;
}

export interface InterpretedRequest {
  tasks: InterpretedTask[];
  reasoning: string;
}

// ─── Main Function ─────────────────────────────────────────────────────────

/**
 * Interpret a WhatsApp message from Tim as a Squarespace editing request.
 *
 * Uses Claude to:
 * 1. Determine which site(s) the request is about
 * 2. Determine which page to edit (if applicable)
 * 3. Create a clear description for the browser agent
 * 4. Flag requests that need clarification
 *
 * @param messageText — the raw WhatsApp message from Tim
 * @param discoveredSites — sites currently available on the Squarespace dashboard
 *   (the agent can only edit these). When provided, the LLM prompt will show
 *   these as the available sites instead of just the static config.
 */
export async function interpretWhatsAppRequest(
  messageText: string,
  discoveredSites?: DiscoveredSite[],
  referenceImageBase64?: string,
): Promise<InterpretedRequest> {
  const sitesConfig = loadSitesConfig();
  const systemPrompt = buildInterpreterPrompt(sitesConfig, discoveredSites);

  logger.info({ messageText: messageText.substring(0, 100), hasImage: !!referenceImageBase64 }, 'Interpreting WhatsApp request');

  // Build user message — multimodal if image is provided
  const userContent: Anthropic.MessageParam['content'] = referenceImageBase64
    ? [
        {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: 'image/jpeg' as const,
            data: referenceImageBase64,
          },
        },
        {
          type: 'text' as const,
          text: messageText || 'See the attached screenshot for what to change.',
        },
      ]
    : messageText;

  const response = await getAnthropicClient().messages.create({
    model: MODEL_SONNET,
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  const responseText = textBlock?.type === 'text' ? textBlock.text : '';

  const result = parseInterpreterResponse(responseText);

  logger.info(
    { taskCount: result.tasks.length, reasoning: result.reasoning.substring(0, 100) },
    'WhatsApp request interpreted',
  );

  return result;
}

// ─── Prompt Building ───────────────────────────────────────────────────────

function buildInterpreterPrompt(sitesConfig: SitesConfig, discoveredSites?: DiscoveredSite[]): string {
  // Build the list of available sites from dashboard discovery (primary)
  // and static config (supplemental metadata like page names)
  let availableSitesList: string;

  if (discoveredSites && discoveredSites.length > 0) {
    // Show the actual sites the agent has access to on the dashboard
    availableSitesList = discoveredSites
      .map((ds) => {
        // Find matching static config to get page metadata
        const staticMatch = sitesConfig.clients.find((c) => {
          const nameMatch = c.name.toLowerCase() === ds.name.toLowerCase()
            || c.name.toLowerCase().replace(/\s*\(copy\)\s*/g, '') === ds.name.toLowerCase().replace(/\s*\(copy\)\s*/g, '')
            || c.aliases.some((a) => a.toLowerCase() === ds.name.toLowerCase().replace(/\s*\(copy\)\s*/g, ''));
          return nameMatch;
        });

        const pages = staticMatch
          ? staticMatch.site.pages.map((p) => `${p.title} (/${p.slug})`).join(', ')
          : 'pages will be discovered at runtime';
        const aliases = staticMatch ? staticMatch.aliases.join(', ') : '';
        const group = staticMatch?.group || 'none';

        const domainInfo = ds.customDomain ? `, domain: ${ds.customDomain}` : '';
        return `- "${ds.name}" (subdomain: ${ds.subdomain}${domainInfo}${aliases ? `, aliases: [${aliases}]` : ''}, group: "${group}")\n  Pages: ${pages}`;
      })
      .join('\n');
  } else {
    // Fallback: show static config if no discovered sites
    availableSitesList = sitesConfig.clients
      .map((c) => {
        const aliases = c.aliases.join(', ');
        const pages = c.site.pages.map((p) => `${p.title} (/${p.slug})`).join(', ');
        return `- ${c.name} (id: "${c.id}", aliases: [${aliases}], group: "${c.group || 'none'}")\n  Pages: ${pages}`;
      })
      .join('\n');
  }

  const groupList = sitesConfig.groups
    .map((g) => {
      const aliases = g.aliases.join(', ');
      return `- ${g.name} (id: "${g.id}", aliases: [${aliases}])`;
    })
    .join('\n');

  return `You are a Squarespace editing assistant. Tim manages multiple restaurant websites and sends you WhatsApp messages with editing requests.

Your job is to interpret Tim's message and determine:
1. Which site(s) the request is about
2. Which page to edit (if applicable)
3. What needs to be done

## Available Sites (on the agent's Squarespace dashboard)
These are the sites the agent currently has access to edit:
${availableSitesList}

## Groups (multiple sites)
${groupList}

## Squarespace Feature Locations — ALWAYS use these exact paths in descriptions
These are the CORRECT navigation paths in the Squarespace editor. NEVER guess — use these:

### Page Content (sections, blocks, text, images)
- Navigate to the page in the Pages panel, then click "Edit" to enter edit mode
- Add sections by hovering between sections → "Add Section" → "+ Add Blank" → "Section"
- Add blocks via "Add Block" button in TOP-LEFT corner of editor → search bar to find blocks

### Announcement Bar (PAID FEATURE — Business/Commerce plans only)
- Path: Click the **Pages icon** (stacked papers) in the left sidebar → scroll DOWN past all pages → expand **"Marketing Tools"** → click **"Announcement Bar"**
- Enable it via the dropdown, type the message text, optionally add a clickthrough URL, then Save
- It appears on EVERY page (cannot be per-page)
- NOT under the Design/paintbrush icon. NOT in Site Styles. It's under **Marketing Tools** in the Pages panel.
- ⚠️ This feature requires a Business or Commerce plan. If the site is on a lower plan, tell Tim this feature is not available on his current plan.

### Site Header & Navigation
- Path: Click the **paintbrush/Design icon** → **"Site Header"**
- Controls logo, navigation layout, header style, social icons

### Site Styles (fonts, colors, spacing)
- Path: Click the **paintbrush/Design icon** → **"Site Styles"**
- Controls global fonts, colors, spacing, buttons — NOT announcement bars or headers

### Pages & Navigation
- Path: Click the **pages icon** (stacked papers) in the left sidebar
- Add/remove/reorder pages, set page titles, manage navigation

### Pop-ups (PAID FEATURE — Business/Commerce plans only)
- Path: Pages icon → scroll down → Marketing Tools → Promotional Pop-Up

## Instructions
1. Match Tim's request to one of the available sites listed above. Use the site name, aliases, or context clues. The siteId you output MUST be the **subdomain** of the matched site (e.g., "grey-yellow-hbxc"), NOT a static ID.
2. If Tim mentions "all sites", "all restaurants", "everywhere", or a group name/alias, set applyToAllSites=true and provide the groupId.
3. If you can't confidently determine which site Tim is referring to — or if the message doesn't mention any site name, alias, or clear context clue — set needsClarification=true and ask which site. This includes generic requests like "update the homepage" without specifying which site. List the available site names so Tim can choose.
4. Determine the target page if the request is about a specific page. Use the page slugs listed for each site.
5. Write a clear, detailed "description" that tells a browser automation agent exactly what to do on the Squarespace editor page. **Use the Squarespace Feature Locations above** for correct navigation paths — NEVER guess paths.
6. One message may contain multiple tasks — split them appropriately.
7. If a request is conversational (like "thanks", "hi", "how are you") or an informational question that does NOT request an edit (like "what sites do you manage?", "what can you do?", "how does this work?", "what's the status?"), return zero tasks.
8. If Tim mentions a site that isn't in the available list, set needsClarification=true and tell Tim the site wasn't found on the dashboard. List the available sites AND tell Tim he can add it by inviting agentcarlcox@gmail.com as a contributor on that Squarespace site.
9. If an image is attached, use it to understand what Tim is referring to (e.g., which button, which section, which text to remove or change). Describe the visual element clearly in the task description so the browser agent knows what to look for.
10. If the message contains a \`--- PDF Content from '...' ---\` section, the user has uploaded a PDF whose text has been extracted. Use this content for the task. If Tim says to "add this to a new page", create a task with a description that tells the browser agent to: create a new page with an appropriate title derived from the PDF content, then add the PDF text content to the page using text blocks. Include the full PDF text in the description so the agent has the content to add.

## Response Format
Respond with JSON only:
\`\`\`json
{
  "reasoning": "Tim wants to remove the happy hour special from the Smyth Tavern site.",
  "tasks": [
    {
      "siteId": "grey-yellow-hbxc",
      "clientName": "Smyth Tavern (Copy)",
      "targetPage": "menus",
      "description": "Find and remove the section containing 'Happy Hour' text from the menus page. Select the section, click Remove, and confirm deletion.",
      "applyToAllSites": false,
      "groupId": null,
      "needsClarification": false,
      "clarificationQuestion": null
    }
  ]
}
\`\`\`

If clarification is needed:
\`\`\`json
{
  "reasoning": "Tim wants to update specials but didn't specify which restaurant.",
  "tasks": [
    {
      "siteId": "unknown",
      "clientName": "Unknown",
      "targetPage": null,
      "description": "Update the specials page",
      "applyToAllSites": false,
      "groupId": null,
      "needsClarification": true,
      "clarificationQuestion": "Which restaurant's specials should I update? I have access to: Smyth Tavern (Copy)"
    }
  ]
}
\`\`\``;
}

// ─── Response Parsing ──────────────────────────────────────────────────────

function parseInterpreterResponse(responseText: string): InterpretedRequest {
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

    const tasks: InterpretedTask[] = parsed.tasks.map((t: Record<string, unknown>) => ({
      siteId: (t.siteId as string) || 'unknown',
      clientName: (t.clientName as string) || 'Unknown',
      targetPage: (t.targetPage as string) || undefined,
      description: (t.description as string) || 'Unknown task',
      applyToAllSites: (t.applyToAllSites as boolean) || false,
      groupId: (t.groupId as string) || undefined,
      needsClarification: (t.needsClarification as boolean) || false,
      clarificationQuestion: (t.clarificationQuestion as string) || undefined,
    }));

    return {
      tasks,
      reasoning: (parsed.reasoning as string) || '',
    };
  } catch (err) {
    logger.error(
      { error: err, responseText: responseText.substring(0, 500) },
      'Failed to parse WhatsApp request interpretation',
    );
    return {
      tasks: [],
      reasoning: `Failed to parse response: ${err}`,
    };
  }
}
