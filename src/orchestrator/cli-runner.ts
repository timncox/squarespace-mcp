import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { logger } from '../utils/logger.js';

export interface AgentConfig {
  name: string;
  model: 'sonnet' | 'haiku' | 'opus';
  maxTurns: number;
  systemPromptFile: string;
  allowedTools?: string[];
  mcpConfig: string;
}

export interface AgentResult {
  success: boolean;
  text: string;
  usage: { input_tokens: number; output_tokens: number };
  cost: number;
  numTurns: number;
  sessionId: string;
}

export interface AgentStepEvent {
  agent: string;
  step: number;
  text: string;
  tools: Array<{ tool: string; input: any }>;
}

export interface RunOptions {
  onStep?: (step: AgentStepEvent) => void;
  timeout?: number;  // ms, default 5 minutes
}

export function runAgent(
  config: AgentConfig,
  input: string,
  options: RunOptions = {},
): Promise<AgentResult> {
  const { onStep, timeout = 300_000 } = options;

  return new Promise((resolve, reject) => {
    const args = [
      '-p', input,
      '--output-format', 'stream-json',
      '--model', config.model,
      '--max-turns', String(config.maxTurns),
      '--system-prompt-file', config.systemPromptFile,
      '--mcp-config', config.mcpConfig,
      '--permission-mode', 'bypassPermissions',
      '--dangerously-skip-permissions',
      '--no-session-persistence',
    ];

    if (config.allowedTools) {
      args.push('--allowedTools');
      for (const pattern of config.allowedTools) {
        args.push(pattern);
      }
    }

    // Strip Claude Code env vars to prevent nested CLI detection issues
    const env = { ...process.env };
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDECODE;

    logger.info({ agent: config.name, model: config.model, maxTurns: config.maxTurns }, 'Spawning agent');

    const proc = spawn('claude', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    let stepCount = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill('SIGTERM');
        reject(new Error(`Agent ${config.name} timed out after ${timeout}ms`));
      }
    }, timeout);

    // Swallow stderr — Claude CLI writes progress/warnings there
    proc.stderr?.resume();

    const rl = createInterface({ input: proc.stdout! });

    rl.on('line', (line) => {
      if (!line.trim()) return;

      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        logger.debug({ agent: config.name, line }, 'Non-JSON line from agent');
        return;
      }

      if (msg.type === 'assistant') {
        stepCount++;
        const contentBlocks: any[] = msg.message?.content ?? [];
        const textParts: string[] = [];
        const tools: Array<{ tool: string; input: any }> = [];

        for (const block of contentBlocks) {
          if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'tool_use') {
            tools.push({ tool: block.name, input: block.input });
          }
        }

        if (onStep) {
          onStep({
            agent: config.name,
            step: stepCount,
            text: textParts.join('\n'),
            tools,
          });
        }
      } else if (msg.type === 'result') {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({
            success: msg.subtype === 'success',
            text: msg.result ?? msg.errors?.join('\n') ?? 'Unknown error',
            usage: msg.usage ?? { input_tokens: 0, output_tokens: 0 },
            cost: msg.total_cost_usd ?? 0,
            numTurns: msg.num_turns ?? stepCount,
            sessionId: msg.session_id ?? '',
          });
        }
      }
    });

    proc.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Failed to spawn agent ${config.name}: ${err.message}`));
      }
    });

    proc.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`Agent ${config.name} exited with code ${code}`));
        } else {
          // Process closed without a result message — shouldn't happen normally
          reject(new Error(`Agent ${config.name} exited without producing a result`));
        }
      }
    });
  });
}
