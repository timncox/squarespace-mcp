/**
 * Test: Run the MCP executor agent directly to create a blog post on Smyth Tavern.
 * Skips classify/research/analyze/strategize — just tests if the executor + MCP tools work.
 *
 * Usage: npx tsx scripts/test-mcp-blog.ts
 */

import { runAgent, type AgentConfig } from '../src/orchestrator/cli-runner.js';
import { join } from 'path';

const MCP_CONFIG = join(process.cwd(), 'mcp-config.json');
const PROMPTS_DIR = join(process.cwd(), 'src', 'orchestrator', 'prompts');

const executorConfig: AgentConfig = {
  name: 'executor',
  model: 'sonnet',
  maxTurns: 30,
  systemPromptFile: join(PROMPTS_DIR, 'executor.md'),
  allowedTools: ['mcp__squarespace__sq_*'],
  mcpConfig: MCP_CONFIG,
};

const input = `Site: grey-yellow-hbxc

## Plan

Create a new blog post on the Smyth Tavern site. Steps:

1. List pages to find the blog collection (look for type 11 / typeName "blog")
2. Create a blog post titled "Summer Cocktail Menu 2026" with the following body content:
   - An intro paragraph about the new summer cocktail offerings
   - 3-4 cocktail descriptions with creative names, ingredients, and prices
   - A closing paragraph inviting guests to come try them
3. Publish the post (draft: false)
`;

console.log('Starting MCP executor test — creating blog post on Smyth Tavern...\n');

try {
  const result = await runAgent(executorConfig, input, {
    timeout: 120_000,
    onStep: (step) => {
      console.log(`\n--- Step ${step.step} (${step.agent}) ---`);
      if (step.text) console.log(step.text.substring(0, 200));
      for (const t of step.tools) {
        console.log(`  → ${t.tool}(${JSON.stringify(t.input).substring(0, 120)}...)`);
      }
    },
  });

  console.log('\n\n=== RESULT ===');
  console.log(`Success: ${result.success}`);
  console.log(`Turns: ${result.numTurns}`);
  console.log(`Cost: $${result.cost.toFixed(4)}`);
  console.log(`\nOutput:\n${result.text}`);
} catch (err) {
  console.error('Failed:', err);
  process.exit(1);
}
