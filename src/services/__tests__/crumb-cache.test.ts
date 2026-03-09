import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

// ── In-memory SQLite with crumb_cache schema ─────────────────────────────

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS crumb_cache (
      site_subdomain TEXT PRIMARY KEY,
      crumb_token TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  return db;
}

let testDb: Database.Database;

vi.mock('../../db/database.js', () => ({
  getDb: () => testDb,
  getCachedCrumb: (siteSubdomain: string): string | null => {
    const row = testDb.prepare('SELECT crumb_token FROM crumb_cache WHERE site_subdomain = ?').get(siteSubdomain) as { crumb_token: string } | undefined;
    return row?.crumb_token ?? null;
  },
  setCachedCrumb: (siteSubdomain: string, crumbToken: string): void => {
    testDb.prepare(
      'INSERT INTO crumb_cache (site_subdomain, crumb_token, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(site_subdomain) DO UPDATE SET crumb_token = excluded.crumb_token, updated_at = excluded.updated_at'
    ).run(siteSubdomain, crumbToken);
  },
}));

const MOCK_SESSION = {
  cookies: [
    { name: 'SS_SESSION_ID', value: 'sess123', domain: '.squarespace.com', path: '/' },
    { name: 'crumb', value: 'old-crumb', domain: '.test-site.squarespace.com', path: '/' },
    { name: 'member-session', value: 'member789', domain: '.test-site.squarespace.com', path: '/' },
  ],
};

let writtenData: string | null = null;

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readFileSync: vi.fn((path: string) => {
      // Pass through package.json lookups for PROJECT_ROOT detection
      if (typeof path === 'string' && path.endsWith('package.json')) {
        return actual.readFileSync(path);
      }
      return JSON.stringify(MOCK_SESSION);
    }),
    existsSync: vi.fn((path: string) => {
      // Pass through package.json lookups for PROJECT_ROOT detection
      if (typeof path === 'string' && path.endsWith('package.json')) {
        return actual.existsSync(path);
      }
      return true;
    }),
    writeFileSync: vi.fn((_path: string, data: string) => {
      writtenData = data;
    }),
    statSync: vi.fn(() => ({ mtimeMs: Date.now() - 60 * 60 * 1000 })),
    mkdirSync: vi.fn(),
  };
});

// Import after all mocks are set up
const { getCachedCrumb, setCachedCrumb } = await import('../../db/database.js');
const { ContentSaveClient } = await import('../content-save.js');

beforeEach(() => {
  testDb = createTestDb();
  writtenData = null;
});

// ── Unit tests for crumb cache helpers ───────────────────────────────────

describe('crumb cache — SQLite helpers', () => {
  it('setCachedCrumb stores and getCachedCrumb retrieves', () => {
    setCachedCrumb('my-site', 'crumb-token-123');
    expect(getCachedCrumb('my-site')).toBe('crumb-token-123');
  });

  it('setCachedCrumb upserts existing entry', () => {
    setCachedCrumb('my-site', 'old-crumb');
    setCachedCrumb('my-site', 'new-crumb');
    expect(getCachedCrumb('my-site')).toBe('new-crumb');

    // Should only have one row
    const count = testDb.prepare('SELECT COUNT(*) as cnt FROM crumb_cache').get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it('getCachedCrumb returns null for unknown site', () => {
    expect(getCachedCrumb('nonexistent-site')).toBeNull();
  });

  it('stores crumbs independently per site', () => {
    setCachedCrumb('site-a', 'crumb-a');
    setCachedCrumb('site-b', 'crumb-b');
    expect(getCachedCrumb('site-a')).toBe('crumb-a');
    expect(getCachedCrumb('site-b')).toBe('crumb-b');
  });
});

// ── Integration: persistCrumbToSession writes to both JSON and SQLite ────

describe('persistCrumbToSession — SQLite integration', () => {
  it('persistCrumbToSession writes crumb to SQLite', () => {
    const client = new ContentSaveClient('test-site');
    client.loadSessionCookies();

    // Simulate a crumb refresh
    client.updateCrumb('fresh-crumb-xyz');
    client.persistCrumbToSession();

    // Verify SQLite has the new crumb
    expect(getCachedCrumb('test-site')).toBe('fresh-crumb-xyz');
  });

  it('persistCrumbToSession also writes to JSON file', () => {
    const client = new ContentSaveClient('test-site');
    client.loadSessionCookies();

    client.updateCrumb('fresh-crumb-xyz');
    client.persistCrumbToSession();

    // Verify JSON file was also written
    expect(writtenData).not.toBeNull();
    const parsed = JSON.parse(writtenData!);
    const crumbCookie = parsed.cookies.find((c: any) => c.name === 'crumb' && c.domain.includes('test-site'));
    expect(crumbCookie.value).toBe('fresh-crumb-xyz');
  });

  it('loadSessionCookies prefers SQLite crumb over session file crumb', () => {
    // Pre-populate SQLite with a newer crumb
    setCachedCrumb('test-site', 'sqlite-crumb-wins');

    const client = new ContentSaveClient('test-site');
    client.loadSessionCookies();

    // The crumb should come from SQLite, not the session file
    expect(client.crumbToken).toBe('sqlite-crumb-wins');
  });
});
