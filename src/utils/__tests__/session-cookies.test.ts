import { describe, it, expect } from 'vitest';
import {
  selectSiteCookies,
  cookieHeader,
  mergeCapturedCookies,
  hasBrowserSiteSession,
  type SessionCookie,
} from '../session-cookies.js';

const SUB = 'seahorsenyc';

// The shape observed on 2026-10-06 after a fresh relogin + site discovery:
// real browser cookies (with path) followed by captured anonymous ones (no path).
function pollutedSession(): SessionCookie[] {
  return [
    { name: 'member-session', value: 'GLOBAL-REAL', domain: '.squarespace.com', path: '/' },
    { name: 'member-session', value: 'SITE-REAL', domain: 'seahorsenyc.squarespace.com', path: '/' },
    { name: 'crumb', value: 'CRUMB-REAL', domain: 'seahorsenyc.squarespace.com', path: '/' },
    { name: 'member-session', value: 'ANON', domain: '.seahorsenyc.squarespace.com' },
    { name: 'member-session', value: 'ANON-GLOBAL', domain: '.squarespace.com' },
  ];
}

describe('selectSiteCookies', () => {
  it('prefers the browser-saved site cookie over a later anonymous one (the 401 bug)', () => {
    const { byName } = selectSiteCookies(pollutedSession(), SUB);
    expect(byName.get('member-session')?.value).toBe('SITE-REAL');
    expect(byName.get('crumb')?.value).toBe('CRUMB-REAL');
  });

  it('prefers a site cookie over a global one', () => {
    const { byName } = selectSiteCookies(
      [
        { name: 'x', value: 'global', domain: '.squarespace.com', path: '/' },
        { name: 'x', value: 'site', domain: 'seahorsenyc.squarespace.com' },
      ],
      SUB,
    );
    expect(byName.get('x')?.value).toBe('site');
  });

  it('keeps the old order on ties: later site cookie wins, earlier global wins', () => {
    const { byName } = selectSiteCookies(
      [
        { name: 's', value: 's1', domain: 'seahorsenyc.squarespace.com', path: '/' },
        { name: 's', value: 's2', domain: '.seahorsenyc.squarespace.com', path: '/' },
        { name: 'g', value: 'g1', domain: '.squarespace.com', path: '/' },
        { name: 'g', value: 'acct', domain: 'account.squarespace.com', path: '/' },
      ],
      SUB,
    );
    expect(byName.get('s')?.value).toBe('s2');
    expect(byName.get('g')?.value).toBe('g1');
  });

  it('ignores cookies for other sites', () => {
    const { byName, site, global } = selectSiteCookies(
      [{ name: 'member-session', value: 'other', domain: '.lurefishbar.squarespace.com', path: '/' }],
      SUB,
    );
    expect(byName.size).toBe(0);
    expect(site).toHaveLength(0);
    expect(global).toHaveLength(0);
  });

  it('builds a header with one entry per name', () => {
    const { byName } = selectSiteCookies(pollutedSession(), SUB);
    expect(cookieHeader(byName.values())).toBe('member-session=SITE-REAL; crumb=CRUMB-REAL');
  });
});

describe('mergeCapturedCookies', () => {
  it('never overwrites a browser-saved cookie', () => {
    const existing = pollutedSession().slice(0, 3);
    const changed = mergeCapturedCookies(
      existing,
      [{ name: 'member-session', value: 'ANON', domain: 'seahorsenyc.squarespace.com' }],
      SUB,
    );
    expect(changed).toHaveLength(0);
    expect(existing[1].value).toBe('SITE-REAL');
  });

  it('never writes to the global .squarespace.com domain', () => {
    const existing = pollutedSession().slice(0, 1);
    const changed = mergeCapturedCookies(
      existing,
      [{ name: 'member-session', value: 'ANON-GLOBAL', domain: '.squarespace.com' }],
      SUB,
    );
    expect(changed).toHaveLength(0);
    expect(existing).toEqual([{ name: 'member-session', value: 'GLOBAL-REAL', domain: '.squarespace.com', path: '/' }]);
  });

  it('adds a site cookie the session lacks, and updates a previously captured one', () => {
    const existing: SessionCookie[] = [{ name: 'crumb', value: 'old', domain: '.seahorsenyc.squarespace.com' }];
    const changed = mergeCapturedCookies(
      existing,
      [
        { name: 'member-session', value: 'new-ms', domain: '.seahorsenyc.squarespace.com' },
        { name: 'crumb', value: 'new-crumb', domain: 'seahorsenyc.squarespace.com' },
      ],
      SUB,
    );
    expect(changed.map((c) => c.name).sort()).toEqual(['crumb', 'member-session']);
    expect(existing.find((c) => c.name === 'crumb')?.value).toBe('new-crumb');
  });
});

describe('hasBrowserSiteSession', () => {
  it('is true only for a path-bearing site member-session', () => {
    expect(hasBrowserSiteSession(pollutedSession(), SUB)).toBe(true);
    expect(hasBrowserSiteSession(pollutedSession().slice(3), SUB)).toBe(false);
    expect(hasBrowserSiteSession(pollutedSession(), 'lurefishbar')).toBe(false);
  });
});
