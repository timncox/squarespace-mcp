import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing session module
const mockClient = {
  getPageSections: vi.fn(),
  patchTextBlock: vi.fn(),
  updateTextBlock: vi.fn(),
  addBlankSection: vi.fn(),
  getSectionCatalog: vi.fn(),
  copyTemplateSection: vi.fn(),
  removeBlock: vi.fn(),
  loadSessionCookies: vi.fn(),
};

const mockMediaClient = {
  loadSessionCookies: vi.fn(),
  uploadImage: vi.fn(),
};

vi.mock('../../services/content-save.js', () => ({
  createContentSaveClient: vi.fn(() => mockClient),
  ContentSaveClient: vi.fn(),
}));

vi.mock('../../services/media-upload.js', () => {
  const MockMediaUploadClient = function(this: any) {
    Object.assign(this, mockMediaClient);
  };
  return { MediaUploadClient: MockMediaUploadClient };
});

vi.mock('../../services/page-id-resolver.js', () => ({
  resolvePageIds: vi.fn(async (subdomain: string, slug: string) => ({
    pageSectionsId: `psi-${slug}`,
    collectionId: `col-${slug}`,
  })),
}));

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => JSON.stringify({
    clients: [
      {
        id: 'smyth-tavern',
        name: 'Smyth Tavern',
        aliases: ['Smyth', 'smyth tavern', "Smyth's"],
        site: {
          adminUrl: 'https://grey-yellow-hbxc.squarespace.com/config/website',
          customDomain: 'https://smythtavern.com',
        },
      },
      {
        id: 'tim-cox',
        name: 'Tim Cox',
        aliases: ['Tim', 'my site'],
        site: {
          adminUrl: 'https://tim-cox.squarespace.com/config/website',
        },
      },
    ],
  })),
}));

import { getSubdomain, getClient, getMediaClient, resolvePageIds, reloadAllSessions, listSites } from '../session.js';
import { createContentSaveClient } from '../../services/content-save.js';

describe('MCP session management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reloadAllSessions(); // Clear caches between tests
  });

  describe('getSubdomain', () => {
    it('should extract subdomain from adminUrl', () => {
      expect(getSubdomain('smyth-tavern')).toBe('grey-yellow-hbxc');
    });

    it('should handle different site IDs', () => {
      expect(getSubdomain('tim-cox')).toBe('tim-cox');
    });

    it('should throw for unknown siteId', () => {
      expect(() => getSubdomain('nonexistent')).toThrow('Unknown site: "nonexistent"');
    });

    it('should list available sites in error message', () => {
      expect(() => getSubdomain('bad')).toThrow(/Available:.*smyth-tavern.*tim-cox/);
    });

    it('should match by name (case-insensitive)', () => {
      expect(getSubdomain('Smyth Tavern')).toBe('grey-yellow-hbxc');
      expect(getSubdomain('smyth tavern')).toBe('grey-yellow-hbxc');
      expect(getSubdomain('Tim Cox')).toBe('tim-cox');
    });

    it('should match by alias', () => {
      expect(getSubdomain('Smyth')).toBe('grey-yellow-hbxc');
      expect(getSubdomain("Smyth's")).toBe('grey-yellow-hbxc');
      expect(getSubdomain('my site')).toBe('tim-cox');
    });

    it('should match by subdomain', () => {
      expect(getSubdomain('grey-yellow-hbxc')).toBe('grey-yellow-hbxc');
    });
  });

  describe('listSites', () => {
    it('should return all configured sites', () => {
      const sites = listSites();
      expect(sites).toHaveLength(2);
      expect(sites[0]).toEqual({
        id: 'smyth-tavern',
        name: 'Smyth Tavern',
        subdomain: 'grey-yellow-hbxc',
        aliases: ['Smyth', 'smyth tavern', "Smyth's"],
        adminUrl: 'https://grey-yellow-hbxc.squarespace.com/config/website',
        customDomain: 'https://smythtavern.com',
        hasCommerceApi: false,
      });
      expect(sites[1].id).toBe('tim-cox');
    });
  });

  describe('getClient', () => {
    it('should create a ContentSaveClient for known site', () => {
      const client = getClient('smyth-tavern');
      expect(client).toBeDefined();
      expect(createContentSaveClient).toHaveBeenCalledWith('grey-yellow-hbxc');
    });

    it('should cache clients per siteId', () => {
      const client1 = getClient('smyth-tavern');
      const client2 = getClient('smyth-tavern');
      expect(client1).toBe(client2);
      expect(createContentSaveClient).toHaveBeenCalledTimes(1);
    });

    it('should create separate clients for different sites', () => {
      getClient('smyth-tavern');
      getClient('tim-cox');
      expect(createContentSaveClient).toHaveBeenCalledTimes(2);
    });

    it('should share cache across id, name, and alias for same site', () => {
      const c1 = getClient('smyth-tavern');
      const c2 = getClient('Smyth Tavern');
      const c3 = getClient('Smyth');
      expect(c1).toBe(c2);
      expect(c1).toBe(c3);
      expect(createContentSaveClient).toHaveBeenCalledTimes(1);
    });
  });

  describe('getMediaClient', () => {
    it('should create and cache MediaUploadClient', () => {
      const client1 = getMediaClient('smyth-tavern');
      const client2 = getMediaClient('smyth-tavern');
      expect(client1).toBe(client2);
      expect(mockMediaClient.loadSessionCookies).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolvePageIds', () => {
    it('should map siteId to subdomain before resolving', async () => {
      const result = await resolvePageIds('smyth-tavern', 'home');
      expect(result).toEqual({ pageSectionsId: 'psi-home', collectionId: 'col-home' });
    });
  });

  describe('reloadAllSessions', () => {
    it('should clear caches and force re-creation', () => {
      getClient('smyth-tavern');
      expect(createContentSaveClient).toHaveBeenCalledTimes(1);

      reloadAllSessions();

      getClient('smyth-tavern');
      expect(createContentSaveClient).toHaveBeenCalledTimes(2);
    });
  });
});
