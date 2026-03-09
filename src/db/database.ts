import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from '../utils/logger.js';

const DB_PATH = process.env.DB_PATH || join(process.cwd(), 'data', 'sqhelper.db');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  // Ensure directory exists
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);

  // Enable WAL mode for better concurrent read/write performance
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  // Run migrations
  migrate(db);

  logger.info({ path: DB_PATH }, 'Database initialized');
  return db;
}

function migrate(db: Database.Database): void {
  // ── Drop vestigial tables from old orchestrator/dashboard architecture ──
  db.exec(`
    DROP TABLE IF EXISTS agent_events;
    DROP TABLE IF EXISTS plan_operations;
    DROP TABLE IF EXISTS whatsapp_messages;
    DROP TABLE IF EXISTS audit_log;
    DROP TABLE IF EXISTS attachments;
    DROP TABLE IF EXISTS learnings;
    DROP TABLE IF EXISTS user_memories;
    DROP TABLE IF EXISTS browser_fallbacks;
    DROP TABLE IF EXISTS tasks;
    DROP TABLE IF EXISTS conversations;
    DROP TABLE IF EXISTS emails;
  `);

  // ── Active tables ──────────────────────────────────────────────────────

  // Page ID cache — resolves page slugs to API IDs (pageSectionsId, collectionId)
  db.exec(`
    CREATE TABLE IF NOT EXISTS page_id_cache (
      subdomain TEXT NOT NULL,
      slug TEXT NOT NULL,
      page_sections_id TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      cached_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (subdomain, slug)
    )
  `);

  // Template discovery cache — caches section template catalogs per site
  db.exec(`
    CREATE TABLE IF NOT EXISTS template_cache (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      categories_json TEXT NOT NULL,
      discovered_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_template_cache_site ON template_cache(site_id);
    CREATE INDEX IF NOT EXISTS idx_template_cache_expires ON template_cache(expires_at);
  `);

  // Template section registry — maps category+templateName → sectionId per site
  db.exec(`
    CREATE TABLE IF NOT EXISTS template_sections (
      site_id TEXT NOT NULL,
      category TEXT NOT NULL,
      template_name TEXT NOT NULL,
      section_id TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (site_id, category, template_name)
    );

    CREATE INDEX IF NOT EXISTS idx_template_sections_site ON template_sections(site_id);
  `);

  // Dynamic site discovery — auto-discovered from login cookies
  db.exec(`
    CREATE TABLE IF NOT EXISTS discovered_sites (
      subdomain TEXT PRIMARY KEY,
      site_title TEXT,
      admin_url TEXT NOT NULL,
      custom_domain TEXT,
      discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_verified_at TEXT
    );
  `);

  // Section snapshots — undo/recovery for page sections
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

  // Phase 22: Crumb token cache — atomic crumb persistence to prevent race conditions
  db.exec(`
    CREATE TABLE IF NOT EXISTS crumb_cache (
      site_subdomain TEXT PRIMARY KEY,
      crumb_token TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  logger.debug('Database migrations applied');
}

export function getCachedCrumb(siteSubdomain: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT crumb_token FROM crumb_cache WHERE site_subdomain = ?').get(siteSubdomain) as { crumb_token: string } | undefined;
  return row?.crumb_token ?? null;
}

export function setCachedCrumb(siteSubdomain: string, crumbToken: string): void {
  const db = getDb();
  db.prepare(
    'INSERT INTO crumb_cache (site_subdomain, crumb_token, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(site_subdomain) DO UPDATE SET crumb_token = excluded.crumb_token, updated_at = excluded.updated_at'
  ).run(siteSubdomain, crumbToken);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Database closed');
  }
}
