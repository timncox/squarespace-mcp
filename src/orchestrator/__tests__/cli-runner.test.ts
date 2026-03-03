import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAgent, type AgentConfig, type AgentStepEvent } from '../cli-runner.js';
import { EventEmitter } from 'events';
import { Readable } from 'stream';

// Mock child_process.spawn
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// Mock logger
vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { spawn } from 'child_process';
const mockSpawn = vi.mocked(spawn);

function createMockProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

function pushLine(proc: any, obj: any) {
  proc.stdout.push(JSON.stringify(obj) + '\n');
}

const BASE_CONFIG: AgentConfig = {
  name: 'test-agent',
  model: 'sonnet',
  maxTurns: 5,
  systemPromptFile: './prompts/test.md',
  mcpConfig: './mcp-config.json',
};

describe('cli-runner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('runAgent', () => {
    it('should resolve with AgentResult on successful result message', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const promise = runAgent(BASE_CONFIG, 'Test prompt');

      // Emit a result message
      pushLine(proc, {
        type: 'result',
        subtype: 'success',
        result: 'Task completed successfully',
        usage: { input_tokens: 100, output_tokens: 50 },
        total_cost_usd: 0.005,
        num_turns: 2,
        session_id: 'sess-123',
      });

      const result = await promise;
      expect(result.success).toBe(true);
      expect(result.text).toBe('Task completed successfully');
      expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 50 });
      expect(result.cost).toBe(0.005);
      expect(result.numTurns).toBe(2);
      expect(result.sessionId).toBe('sess-123');
    });

    it('should resolve with success=false on error result', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const promise = runAgent(BASE_CONFIG, 'Test prompt');

      pushLine(proc, {
        type: 'result',
        subtype: 'error',
        errors: ['Something went wrong', 'Another error'],
      });

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.text).toBe('Something went wrong\nAnother error');
    });

    it('should call onStep for assistant messages', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const steps: AgentStepEvent[] = [];
      const promise = runAgent(BASE_CONFIG, 'Test prompt', {
        onStep: (step) => steps.push(step),
      });

      // Emit assistant message with text and tool_use
      pushLine(proc, {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'I will update the heading' },
            { type: 'tool_use', name: 'sq_update_text', input: { siteId: 'test', searchText: 'Old' } },
          ],
        },
      });

      // Emit result to resolve
      pushLine(proc, {
        type: 'result',
        subtype: 'success',
        result: 'Done',
      });

      await promise;

      expect(steps).toHaveLength(1);
      expect(steps[0].agent).toBe('test-agent');
      expect(steps[0].step).toBe(1);
      expect(steps[0].text).toBe('I will update the heading');
      expect(steps[0].tools).toHaveLength(1);
      expect(steps[0].tools[0].tool).toBe('sq_update_text');
    });

    it('should count steps incrementally', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const steps: AgentStepEvent[] = [];
      const promise = runAgent(BASE_CONFIG, 'Test prompt', {
        onStep: (step) => steps.push(step),
      });

      pushLine(proc, { type: 'assistant', message: { content: [{ type: 'text', text: 'Step 1' }] } });
      pushLine(proc, { type: 'assistant', message: { content: [{ type: 'text', text: 'Step 2' }] } });
      pushLine(proc, { type: 'assistant', message: { content: [{ type: 'text', text: 'Step 3' }] } });
      pushLine(proc, { type: 'result', subtype: 'success', result: 'Done' });

      await promise;

      expect(steps).toHaveLength(3);
      expect(steps[0].step).toBe(1);
      expect(steps[1].step).toBe(2);
      expect(steps[2].step).toBe(3);
    });

    it('should reject on spawn error', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const promise = runAgent(BASE_CONFIG, 'Test prompt');

      proc.emit('error', new Error('ENOENT: claude not found'));

      await expect(promise).rejects.toThrow('Failed to spawn agent test-agent: ENOENT: claude not found');
    });

    it('should reject on non-zero exit code', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const promise = runAgent(BASE_CONFIG, 'Test prompt');

      proc.emit('close', 1);

      await expect(promise).rejects.toThrow('Agent test-agent exited with code 1');
    });

    it('should reject on timeout', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const promise = runAgent(BASE_CONFIG, 'Test prompt', { timeout: 50 });

      await expect(promise).rejects.toThrow('Agent test-agent timed out after 50ms');
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('should build correct CLI args', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const configWithTools: AgentConfig = {
        ...BASE_CONFIG,
        allowedTools: ['mcp__squarespace__sq_read_page', 'mcp__squarespace__sq_update_text'],
      };

      const promise = runAgent(configWithTools, 'Read the page');

      // Resolve immediately
      pushLine(proc, { type: 'result', subtype: 'success', result: 'Done' });
      await promise;

      const [cmd, args, opts] = mockSpawn.mock.calls[0];
      expect(cmd).toBe('claude');
      expect(args).toContain('-p');
      expect(args).toContain('Read the page');
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
      expect(args).toContain('--model');
      expect(args).toContain('sonnet');
      expect(args).toContain('--max-turns');
      expect(args).toContain('5');
      expect(args).toContain('--system-prompt-file');
      expect(args).toContain('./prompts/test.md');
      expect(args).toContain('--mcp-config');
      expect(args).toContain('./mcp-config.json');
      expect(args).toContain('--dangerously-skip-permissions');
      expect(args).toContain('--no-session-persistence');
      expect(args).toContain('--allowedTools');
      expect(args).toContain('mcp__squarespace__sq_read_page');
      expect(args).toContain('mcp__squarespace__sq_update_text');
    });

    it('should strip CLAUDE_CODE_ENTRYPOINT from env', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      process.env.CLAUDE_CODE_ENTRYPOINT = 'test-value';

      const promise = runAgent(BASE_CONFIG, 'Test');
      pushLine(proc, { type: 'result', subtype: 'success', result: 'Done' });
      await promise;

      const env = mockSpawn.mock.calls[0][2]?.env as Record<string, string>;
      expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();

      delete process.env.CLAUDE_CODE_ENTRYPOINT;
    });

    it('should ignore non-JSON lines', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const promise = runAgent(BASE_CONFIG, 'Test');

      proc.stdout.push('Not valid JSON\n');
      proc.stdout.push('Also not JSON\n');
      pushLine(proc, { type: 'result', subtype: 'success', result: 'Done' });

      const result = await promise;
      expect(result.success).toBe(true);
    });

    it('should handle missing fields in result with defaults', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const promise = runAgent(BASE_CONFIG, 'Test');

      pushLine(proc, { type: 'result', subtype: 'success' });

      const result = await promise;
      expect(result.text).toBe('Unknown error');
      expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
      expect(result.cost).toBe(0);
      expect(result.sessionId).toBe('');
    });
  });
});
