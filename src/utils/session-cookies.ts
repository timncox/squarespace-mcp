/**
 * Cookie selection for a Squarespace site, shared by ContentSaveClient and
 * MediaUploadClient.
 *
 * Why this exists (2026-10-06/08, seahorsenyc): site discovery
 * (`captureSiteCookies`) merged anonymous `member-session` cookies — no `path`,
 * appended after the real ones — into the session file. The old loaders let the
 * LAST site-domain cookie win, so the anonymous cookie shadowed the real login
 * and every Content API call 401'd "You are not logged in" right after a fresh
 * relogin. Cookies saved by the browser login always carry a `path`; synthesized
 * ones never do. Rank on that instead of file order.
 */

export interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
}

export function normalizeDomain(domain: string): string {
  return domain.replace(/^\./, '');
}

export function isGlobalDomain(domain: string): boolean {
  return normalizeDomain(domain) === 'squarespace.com';
}

export function isSiteDomain(domain: string, subdomain: string): boolean {
  const d = normalizeDomain(domain);
  return d === `${subdomain}.squarespace.com` || d === 'account.squarespace.com';
}

/** Browser-saved cookies have a path; synthesized/captured ones don't. */
export function isBrowserCookie(c: SessionCookie): boolean {
  return typeof c.path === 'string' && c.path.length > 0;
}

/**
 * Higher is better. A cookie scoped to this site beats a global one, and a
 * browser-saved cookie beats a synthesized one at the same scope.
 * `account.squarespace.com` ranks with the global cookies (the old loader never let
 * it override a global cookie either).
 */
const SITE_SCOPE = 2;
function rank(c: SessionCookie, subdomain: string): number {
  const scope = normalizeDomain(c.domain) === `${subdomain}.squarespace.com` ? SITE_SCOPE : 1;
  return scope * 2 + (isBrowserCookie(c) ? 1 : 0);
}

export interface SelectedCookies {
  global: SessionCookie[];
  site: SessionCookie[];
  /** One cookie per name — the best-ranked candidate. */
  byName: Map<string, SessionCookie>;
}

export function selectSiteCookies(cookies: SessionCookie[], subdomain: string): SelectedCookies {
  const global: SessionCookie[] = [];
  const site: SessionCookie[] = [];
  for (const c of cookies) {
    if (isGlobalDomain(c.domain)) global.push(c);
    else if (isSiteDomain(c.domain, subdomain)) site.push(c);
  }

  const byName = new Map<string, SessionCookie>();
  for (const c of [...global, ...site]) {
    const existing = byName.get(c.name);
    if (!existing) { byName.set(c.name, c); continue; }
    const r = rank(c, subdomain), er = rank(existing, subdomain);
    // Ties keep the old loader's order: later wins among this site's own cookies,
    // earlier (global first) wins otherwise.
    if (r > er || (r === er && r >= SITE_SCOPE * 2)) byName.set(c.name, c);
  }
  return { global, site, byName };
}

export function cookieHeader(cookies: Iterable<SessionCookie>): string {
  return Array.from(cookies).map((c) => `${c.name}=${c.value}`).join('; ');
}

/**
 * Merge cookies captured from a Set-Cookie response into the session list
 * without ever degrading a real login:
 * - never writes to the global `.squarespace.com` domain
 * - never overwrites a browser-saved cookie (one with a path)
 * - only fills names the site doesn't already have from the browser
 * Returns the cookies actually added/updated.
 */
export function mergeCapturedCookies(
  existing: SessionCookie[],
  captured: SessionCookie[],
  subdomain: string,
): SessionCookie[] {
  const changed: SessionCookie[] = [];
  for (const nc of captured) {
    if (!isSiteDomain(nc.domain, subdomain) || normalizeDomain(nc.domain) === 'account.squarespace.com') continue;
    const sameName = existing.filter(
      (c) => c.name === nc.name && normalizeDomain(c.domain) === normalizeDomain(nc.domain),
    );
    if (sameName.some(isBrowserCookie)) continue;
    const prior = sameName[0];
    if (prior) {
      if (prior.value !== nc.value) {
        prior.value = nc.value;
        changed.push(prior);
      }
    } else {
      existing.push(nc);
      changed.push(nc);
    }
  }
  return changed;
}

/** True when the browser login already gave this site a real member-session. */
export function hasBrowserSiteSession(cookies: SessionCookie[], subdomain: string): boolean {
  return cookies.some(
    (c) =>
      c.name === 'member-session' &&
      normalizeDomain(c.domain) === `${subdomain}.squarespace.com` &&
      isBrowserCookie(c),
  );
}
