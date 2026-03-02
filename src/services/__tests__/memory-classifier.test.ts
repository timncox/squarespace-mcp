import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyMemory, isMemoryTrigger, isForgetTrigger, isListMemoriesTrigger } from '../memory-classifier.js';

// Mock the Anthropic client
vi.mock('../../utils/anthropic-client.js', () => ({
  getAnthropicClient: () => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            content: 'Smyth Tavern uses dark themes',
            category: 'site_rule',
            siteId: 'grey-yellow-hbxc',
            tags: ['design', 'theme'],
          }),
        }],
      }),
    },
  }),
}));

vi.mock('../../config/models.js', () => ({
  MODEL_HAIKU: 'claude-haiku-4-5-20251001',
}));

describe('isMemoryTrigger', () => {
  it('detects "remember that" phrases', () => {
    expect(isMemoryTrigger('remember that Smyth uses dark themes')).toBe(true);
    expect(isMemoryTrigger('Remember: always use GBP')).toBe(true);
  });

  it('detects "keep in mind" phrases', () => {
    expect(isMemoryTrigger('keep in mind that site X uses blue')).toBe(true);
  });

  it('detects "don\'t forget" phrases', () => {
    expect(isMemoryTrigger("don't forget that menus should be in pounds")).toBe(true);
  });

  it('detects "always" and "never" as preference indicators', () => {
    expect(isMemoryTrigger('always use formal tone for law firms')).toBe(true);
    expect(isMemoryTrigger('never touch the footer on site X')).toBe(true);
  });

  it('does not trigger on normal task messages', () => {
    expect(isMemoryTrigger('update the menu on Smyth Tavern')).toBe(false);
    expect(isMemoryTrigger('add a new section to the homepage')).toBe(false);
  });

  it('does not trigger on short messages', () => {
    expect(isMemoryTrigger('yes')).toBe(false);
    expect(isMemoryTrigger('no')).toBe(false);
    expect(isMemoryTrigger('ok')).toBe(false);
  });
});

describe('isForgetTrigger', () => {
  it('detects forget requests', () => {
    expect(isForgetTrigger('forget that Smyth uses dark themes')).toBe(true);
    expect(isForgetTrigger('stop remembering that rule about footers')).toBe(true);
  });

  it('does not false-positive on other messages', () => {
    expect(isForgetTrigger('remember that Smyth uses dark themes')).toBe(false);
    expect(isForgetTrigger('update the menu')).toBe(false);
  });
});

describe('isListMemoriesTrigger', () => {
  it('detects list requests', () => {
    expect(isListMemoriesTrigger('what do you remember?')).toBe(true);
    expect(isListMemoriesTrigger('what do you remember about Smyth Tavern?')).toBe(true);
    expect(isListMemoriesTrigger('what do you know about site X?')).toBe(true);
    expect(isListMemoriesTrigger('list memories')).toBe(true);
  });

  it('does not false-positive', () => {
    expect(isListMemoriesTrigger('update the homepage')).toBe(false);
  });
});

describe('classifyMemory', () => {
  it('returns classified memory from LLM response', async () => {
    const result = await classifyMemory('Smyth Tavern uses dark themes');
    expect(result.content).toBe('Smyth Tavern uses dark themes');
    expect(result.category).toBe('site_rule');
    expect(result.siteId).toBe('grey-yellow-hbxc');
    expect(result.tags).toEqual(['design', 'theme']);
  });
});
