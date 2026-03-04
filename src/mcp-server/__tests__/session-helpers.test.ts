import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => JSON.stringify({
    clients: [
      {
        id: 'smyth-tavern',
        name: 'Smyth Tavern',
        aliases: ['smyth'],
        site: {
          adminUrl: 'https://grey-yellow-hbxc.squarespace.com/config',
          customDomain: 'www.smythtavern.com',
        },
      },
      {
        id: 'test-site',
        name: 'Test Site',
        aliases: [],
        site: {
          adminUrl: 'https://test-abc.squarespace.com/config',
        },
      },
    ],
  })),
}));

import { getSiteBaseUrl } from '../session.js';

describe('getSiteBaseUrl', () => {
  it('returns customDomain with https when available', () => {
    const url = getSiteBaseUrl('smyth-tavern');
    expect(url).toBe('https://www.smythtavern.com');
  });

  it('returns squarespace subdomain URL when no customDomain', () => {
    const url = getSiteBaseUrl('test-site');
    expect(url).toBe('https://test-abc.squarespace.com');
  });

  it('throws for unknown site', () => {
    expect(() => getSiteBaseUrl('nonexistent')).toThrow('Unknown site');
  });
});
