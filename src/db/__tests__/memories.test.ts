import { describe, it, expect, beforeEach } from 'vitest';
import { saveMemory, getRelevantMemories, forgetMemory, listMemories, getMemory } from '../memories.js';
import { getDb } from '../database.js';

// Reset memories table before each test
beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM user_memories');
});

describe('saveMemory', () => {
  it('creates a new memory with all fields', () => {
    const mem = saveMemory({
      content: 'Smyth Tavern uses dark themes',
      category: 'site_rule',
      siteId: 'grey-yellow-hbxc',
      tags: ['design', 'theme'],
      source: 'whatsapp',
    });
    expect(mem.id).toBeDefined();
    expect(mem.content).toBe('Smyth Tavern uses dark themes');
    expect(mem.category).toBe('site_rule');
    expect(mem.siteId).toBe('grey-yellow-hbxc');
    expect(mem.tags).toEqual(['design', 'theme']);
    expect(mem.source).toBe('whatsapp');
    expect(mem.active).toBe(true);
  });

  it('creates a global memory when siteId is null', () => {
    const mem = saveMemory({
      content: 'Always confirm before deleting pages',
      category: 'general',
      source: 'dashboard',
    });
    expect(mem.siteId).toBeUndefined();
    expect(mem.active).toBe(true);
  });

  it('deduplicates by content+siteId — updates and reactivates', () => {
    const mem1 = saveMemory({
      content: 'Use formal tone',
      category: 'client_preference',
      siteId: 'site-a',
      source: 'whatsapp',
    });
    forgetMemory(mem1.id);

    const mem2 = saveMemory({
      content: 'Use formal tone',
      category: 'client_preference',
      siteId: 'site-a',
      source: 'dashboard',
    });
    expect(mem2.id).toBe(mem1.id);
    expect(mem2.active).toBe(true);
  });

  it('treats same content with different siteId as separate memories', () => {
    const mem1 = saveMemory({ content: 'Use dark theme', category: 'site_rule', siteId: 'site-a', source: 'whatsapp' });
    const mem2 = saveMemory({ content: 'Use dark theme', category: 'site_rule', siteId: 'site-b', source: 'whatsapp' });
    expect(mem1.id).not.toBe(mem2.id);
  });
});

describe('getRelevantMemories', () => {
  it('returns global + site-specific memories', () => {
    saveMemory({ content: 'Global rule', category: 'general', source: 'whatsapp' });
    saveMemory({ content: 'Site rule', category: 'site_rule', siteId: 'site-a', source: 'whatsapp' });
    saveMemory({ content: 'Other site rule', category: 'site_rule', siteId: 'site-b', source: 'whatsapp' });

    const relevant = getRelevantMemories('site-a');
    expect(relevant).toHaveLength(2);
    expect(relevant.map(m => m.content)).toContain('Global rule');
    expect(relevant.map(m => m.content)).toContain('Site rule');
  });

  it('filters by category', () => {
    saveMemory({ content: 'A preference', category: 'client_preference', source: 'whatsapp' });
    saveMemory({ content: 'A rule', category: 'site_rule', source: 'whatsapp' });

    const rules = getRelevantMemories(undefined, ['site_rule']);
    expect(rules).toHaveLength(1);
    expect(rules[0].content).toBe('A rule');
  });

  it('excludes inactive memories', () => {
    const mem = saveMemory({ content: 'Forgotten', category: 'general', source: 'whatsapp' });
    forgetMemory(mem.id);

    const relevant = getRelevantMemories();
    expect(relevant).toHaveLength(0);
  });

  it('returns empty array when no memories exist', () => {
    expect(getRelevantMemories()).toEqual([]);
  });
});

describe('forgetMemory', () => {
  it('soft-deletes a memory', () => {
    const mem = saveMemory({ content: 'To forget', category: 'general', source: 'whatsapp' });
    forgetMemory(mem.id);

    const fetched = getMemory(mem.id);
    expect(fetched?.active).toBe(false);
  });
});

describe('listMemories', () => {
  it('returns all active memories sorted by most recent', () => {
    saveMemory({ content: 'First', category: 'general', source: 'whatsapp' });
    saveMemory({ content: 'Second', category: 'site_rule', siteId: 'site-a', source: 'dashboard' });

    const all = listMemories();
    expect(all).toHaveLength(2);
  });

  it('filters by siteId', () => {
    saveMemory({ content: 'Global', category: 'general', source: 'whatsapp' });
    saveMemory({ content: 'Site A', category: 'site_rule', siteId: 'site-a', source: 'whatsapp' });

    const siteOnly = listMemories('site-a');
    expect(siteOnly).toHaveLength(1);
    expect(siteOnly[0].content).toBe('Site A');
  });
});
