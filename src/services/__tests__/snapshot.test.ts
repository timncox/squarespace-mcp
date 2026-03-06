import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

// Create in-memory database with Phase 21 migration
function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS section_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id TEXT NOT NULL,
      page_sections_id TEXT NOT NULL,
      collection_id TEXT,
      sections_json TEXT NOT NULL,
      label TEXT,
      is_auto INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_site_page
      ON section_snapshots(site_id, page_sections_id);
    CREATE INDEX IF NOT EXISTS idx_snapshots_created
      ON section_snapshots(created_at);
  `);
  return db;
}

let testDb: Database.Database;

vi.mock('../../db/database.js', () => ({
  getDb: () => testDb,
}));

// Import after mock setup
const { saveSnapshot, listSnapshots, getSnapshot, deleteSnapshot, shouldAutoSnapshot, cleanupOldSnapshots } =
  await import('../snapshot.js');

const SITE_ID = 'site-abc';
const PAGE_ID = 'page-123';
const COLLECTION_ID = 'col-456';
const SECTIONS = [{ id: 'sec1', sectionName: 'test' }];

beforeEach(() => {
  testDb = createTestDb();
});

describe('snapshot service', () => {
  it('saveSnapshot returns an id', () => {
    const id = saveSnapshot({
      siteId: SITE_ID,
      pageSectionsId: PAGE_ID,
      collectionId: COLLECTION_ID,
      sections: SECTIONS,
      label: 'before redesign',
    });
    expect(id).toBeGreaterThan(0);
  });

  it('listSnapshots returns saved snapshots', () => {
    saveSnapshot({ siteId: SITE_ID, pageSectionsId: PAGE_ID, sections: SECTIONS });
    saveSnapshot({ siteId: SITE_ID, pageSectionsId: PAGE_ID, sections: SECTIONS });

    const list = listSnapshots({ siteId: SITE_ID });
    expect(list).toHaveLength(2);
    expect(list[0].siteId).toBe(SITE_ID);
    expect(list[0].sectionCount).toBe(1);
  });

  it('listSnapshots filters by siteId and pageSectionsId', () => {
    saveSnapshot({ siteId: SITE_ID, pageSectionsId: PAGE_ID, sections: SECTIONS });
    saveSnapshot({ siteId: 'other-site', pageSectionsId: 'other-page', sections: SECTIONS });

    const bySite = listSnapshots({ siteId: SITE_ID });
    expect(bySite).toHaveLength(1);

    const byPage = listSnapshots({ siteId: SITE_ID, pageSectionsId: PAGE_ID });
    expect(byPage).toHaveLength(1);

    const noMatch = listSnapshots({ siteId: SITE_ID, pageSectionsId: 'other-page' });
    expect(noMatch).toHaveLength(0);
  });

  it('listSnapshots excludes auto snapshots when includeAuto=false', () => {
    saveSnapshot({ siteId: SITE_ID, pageSectionsId: PAGE_ID, sections: SECTIONS, isAuto: true });
    saveSnapshot({ siteId: SITE_ID, pageSectionsId: PAGE_ID, sections: SECTIONS, label: 'manual' });

    const all = listSnapshots({ siteId: SITE_ID });
    expect(all).toHaveLength(2);

    const manualOnly = listSnapshots({ siteId: SITE_ID, includeAuto: false });
    expect(manualOnly).toHaveLength(1);
    expect(manualOnly[0].label).toBe('manual');
  });

  it('getSnapshot returns full sections data', () => {
    const id = saveSnapshot({
      siteId: SITE_ID,
      pageSectionsId: PAGE_ID,
      collectionId: COLLECTION_ID,
      sections: SECTIONS,
      label: 'test',
    });

    const snap = getSnapshot(id);
    expect(snap).not.toBeNull();
    expect(snap!.id).toBe(id);
    expect(snap!.siteId).toBe(SITE_ID);
    expect(snap!.collectionId).toBe(COLLECTION_ID);
    expect(snap!.sections).toEqual(SECTIONS);
    expect(snap!.label).toBe('test');
    expect(snap!.isAuto).toBe(false);
  });

  it('getSnapshot returns null for non-existent id', () => {
    expect(getSnapshot(9999)).toBeNull();
  });

  it('deleteSnapshot removes the record', () => {
    const id = saveSnapshot({ siteId: SITE_ID, pageSectionsId: PAGE_ID, sections: SECTIONS });
    expect(deleteSnapshot(id)).toBe(true);
    expect(getSnapshot(id)).toBeNull();
    expect(deleteSnapshot(id)).toBe(false);
  });

  it('shouldAutoSnapshot returns true when no recent snapshot', () => {
    expect(shouldAutoSnapshot(SITE_ID, PAGE_ID)).toBe(true);
  });

  it('shouldAutoSnapshot returns false within dedup window', () => {
    saveSnapshot({ siteId: SITE_ID, pageSectionsId: PAGE_ID, sections: SECTIONS, isAuto: true });
    expect(shouldAutoSnapshot(SITE_ID, PAGE_ID)).toBe(false);
  });

  it('cleanupOldSnapshots removes old auto-snapshots but keeps manual ones', () => {
    // Insert an "old" auto-snapshot by manually setting created_at
    testDb.prepare(
      `INSERT INTO section_snapshots (site_id, page_sections_id, sections_json, is_auto, created_at)
       VALUES (?, ?, ?, 1, datetime('now', '-30 days'))`,
    ).run(SITE_ID, PAGE_ID, JSON.stringify(SECTIONS));

    // Insert a "old" manual snapshot
    testDb.prepare(
      `INSERT INTO section_snapshots (site_id, page_sections_id, sections_json, is_auto, created_at)
       VALUES (?, ?, ?, 0, datetime('now', '-30 days'))`,
    ).run(SITE_ID, PAGE_ID, JSON.stringify(SECTIONS));

    // Insert a recent auto-snapshot
    saveSnapshot({ siteId: SITE_ID, pageSectionsId: PAGE_ID, sections: SECTIONS, isAuto: true });

    const deleted = cleanupOldSnapshots(7);
    expect(deleted).toBe(1);

    const remaining = listSnapshots({ siteId: SITE_ID });
    expect(remaining).toHaveLength(2); // manual + recent auto
  });
});
