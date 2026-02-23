/**
 * Shared Anthropic client singleton.
 *
 * Every file that needs to call Claude should import `getAnthropicClient()`
 * from here instead of creating its own lazy-loaded instance.
 */

import Anthropic from '@anthropic-ai/sdk';

let _client: Anthropic | null = null;

/**
 * Returns the shared Anthropic client instance.
 * Creates it on first call (reads ANTHROPIC_API_KEY from env automatically).
 */
export function getAnthropicClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic();
  }
  return _client;
}
