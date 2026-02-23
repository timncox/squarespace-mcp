import { logger } from '../../utils/logger.js';
import type { AgentAction } from './types.js';

/**
 * Parse the LLM response text into a typed AgentAction.
 * Handles both raw JSON and markdown code-fenced JSON.
 */
export function parseAgentAction(responseText: string): AgentAction | null {
  try {
    // Try extracting JSON from markdown code fence
    const fenceMatch = responseText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    const jsonStr = fenceMatch ? fenceMatch[1] : responseText;

    // Find the JSON object in the text
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.action) return null;

    return parsed as AgentAction;
  } catch (err) {
    logger.warn({ error: err, responseText: responseText.substring(0, 200) }, 'Failed to parse agent action');
    return null;
  }
}
