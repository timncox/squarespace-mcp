import { describe, it, expect } from 'vitest';

/**
 * Tests for the navigation verification logic used in supervisor's collectApiEvidence().
 * These test the slug-matching algorithm directly (same logic as in supervisor-agent.ts).
 */

interface NavItem {
  id: string;
  title: string;
  urlSlug?: string;
  enabled?: boolean;
  isDraft?: boolean;
  isFolder?: boolean;
  children?: NavItem[];
}

function findPageInNavigation(
  navData: { mainNavigation: NavItem[]; notLinked: NavItem[] },
  slug: string,
): boolean {
  const allPages = [...navData.mainNavigation, ...navData.notLinked];
  const flatPages = allPages.flatMap(p => [p, ...(p.children ?? [])]);
  return flatPages.some(p => p.urlSlug?.toLowerCase() === slug.toLowerCase());
}

describe('supervisor navigation verification', () => {
  it('should detect created page in navigation', () => {
    const navData = {
      mainNavigation: [
        { id: '1', title: 'Home', urlSlug: 'home', enabled: true },
        { id: '2', title: 'About', urlSlug: 'about', enabled: true },
        { id: '3', title: 'New Page', urlSlug: 'new-page', enabled: true },
      ],
      notLinked: [],
    };

    expect(findPageInNavigation(navData, 'new-page')).toBe(true);
  });

  it('should detect deleted page is gone', () => {
    const navData = {
      mainNavigation: [
        { id: '1', title: 'Home', urlSlug: 'home', enabled: true },
        { id: '2', title: 'About', urlSlug: 'about', enabled: true },
      ],
      notLinked: [],
    };

    expect(findPageInNavigation(navData, 'deleted-page')).toBe(false);
  });

  it('should search children (nested pages)', () => {
    const navData = {
      mainNavigation: [
        {
          id: '1', title: 'Services', urlSlug: 'services', isFolder: true,
          children: [
            { id: '2', title: 'Web Design', urlSlug: 'web-design', enabled: true },
            { id: '3', title: 'SEO', urlSlug: 'seo', enabled: true },
          ],
        },
      ],
      notLinked: [],
    };

    expect(findPageInNavigation(navData, 'web-design')).toBe(true);
  });

  it('should search notLinked pages', () => {
    const navData = {
      mainNavigation: [
        { id: '1', title: 'Home', urlSlug: 'home', enabled: true },
      ],
      notLinked: [
        { id: '2', title: 'Draft Page', urlSlug: 'draft-page', isDraft: true },
      ],
    };

    expect(findPageInNavigation(navData, 'draft-page')).toBe(true);
  });

  it('should handle case-insensitive slug matching', () => {
    const navData = {
      mainNavigation: [
        { id: '1', title: 'About Us', urlSlug: 'About-Us', enabled: true },
      ],
      notLinked: [],
    };

    expect(findPageInNavigation(navData, 'about-us')).toBe(true);
  });

  it('should not find page when slug is absent', () => {
    const navData = {
      mainNavigation: [
        { id: '1', title: 'Home', urlSlug: 'home', enabled: true },
        { id: '2', title: 'About', urlSlug: 'about', enabled: true },
      ],
      notLinked: [
        { id: '3', title: 'Hidden', urlSlug: 'hidden-page', enabled: false },
      ],
    };

    expect(findPageInNavigation(navData, 'contact')).toBe(false);
  });

  it('should find page in both mainNavigation children and notLinked', () => {
    const navData = {
      mainNavigation: [
        {
          id: '1', title: 'Services', urlSlug: 'services', isFolder: true,
          children: [
            { id: '2', title: 'Consulting', urlSlug: 'consulting', enabled: true },
          ],
        },
      ],
      notLinked: [
        { id: '3', title: 'Test Page', urlSlug: 'test-page', isDraft: true },
      ],
    };

    expect(findPageInNavigation(navData, 'consulting')).toBe(true);
    expect(findPageInNavigation(navData, 'test-page')).toBe(true);
    expect(findPageInNavigation(navData, 'nonexistent')).toBe(false);
  });

  it('should handle empty navigation', () => {
    const navData = {
      mainNavigation: [],
      notLinked: [],
    };

    expect(findPageInNavigation(navData, 'any-page')).toBe(false);
  });
});
