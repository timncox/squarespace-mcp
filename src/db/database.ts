import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from '../utils/logger.js';
import { errMsg } from '../utils/errors.js';

const DB_PATH = join(process.cwd(), 'data', 'sqhelper.db');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  // Ensure directory exists
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);

  // Enable WAL mode for better concurrent read/write performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Run migrations
  migrate(db);

  logger.info({ path: DB_PATH }, 'Database initialized');
  return db;
}

function migrate(db: Database.Database): void {
  // Create tables if they don't exist
  // Create tables if they don't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS emails (
      id TEXT PRIMARY KEY,
      gmail_message_id TEXT UNIQUE NOT NULL,
      gmail_thread_id TEXT,
      from_address TEXT NOT NULL,
      from_name TEXT,
      subject TEXT,
      body_text TEXT,
      body_html TEXT,
      original_sender_email TEXT,
      original_sender_name TEXT,
      received_at TEXT NOT NULL,
      processed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      email_id TEXT REFERENCES emails(id),
      task_type TEXT NOT NULL,
      client_name TEXT NOT NULL,
      site_id TEXT NOT NULL,
      target_page TEXT,
      content_to_find TEXT,
      content_to_add TEXT,
      attachment_filename TEXT,
      attachment_path TEXT,
      apply_to_all_sites INTEGER NOT NULL DEFAULT 0,
      group_id TEXT,
      needs_clarification INTEGER NOT NULL DEFAULT 0,
      clarification_question TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      screenshot_path TEXT,
      original_content TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT REFERENCES tasks(id),
      action TEXT NOT NULL,
      details TEXT,
      screenshot_path TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      email_id TEXT REFERENCES emails(id),
      filename TEXT NOT NULL,
      mime_type TEXT,
      file_path TEXT NOT NULL,
      size_bytes INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      email_id TEXT REFERENCES emails(id),
      status TEXT NOT NULL DEFAULT 'awaiting_confirm',
      task_ids TEXT NOT NULL DEFAULT '[]',
      summary_text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT REFERENCES conversations(id),
      wa_message_id TEXT,
      direction TEXT NOT NULL,
      from_number TEXT NOT NULL,
      to_number TEXT NOT NULL,
      body TEXT NOT NULL,
      media_url TEXT,
      timestamp TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_email_id ON tasks(email_id);
    CREATE INDEX IF NOT EXISTS idx_emails_gmail_id ON emails(gmail_message_id);
    CREATE INDEX IF NOT EXISTS idx_audit_task_id ON audit_log(task_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
    CREATE INDEX IF NOT EXISTS idx_conversations_email_id ON conversations(email_id);
    CREATE INDEX IF NOT EXISTS idx_wa_messages_conversation_id ON whatsapp_messages(conversation_id);
  `);

  // Phase 4 migrations — add new columns safely
  addColumnIfMissing(db, 'tasks', 'description', 'TEXT');
  addColumnIfMissing(db, 'conversations', 'source', "TEXT NOT NULL DEFAULT 'email'");

  // Phase 5 migrations — multi-agent content planning
  addColumnIfMissing(db, 'conversations', 'content_plan', 'TEXT');
  addColumnIfMissing(db, 'conversations', 'plan_feedback', 'TEXT');

  // Phase 6 migrations — Learning Agent (cross-execution memory)
  db.exec(`
    CREATE TABLE IF NOT EXISTS learnings (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      pattern_key TEXT NOT NULL,
      description TEXT NOT NULL,
      prompt_tip TEXT NOT NULL,
      site_id TEXT,
      page_context TEXT,
      confidence REAL NOT NULL DEFAULT 0.5,
      confirmation_count INTEGER NOT NULL DEFAULT 1,
      contradiction_count INTEGER NOT NULL DEFAULT 0,
      source_task_id TEXT REFERENCES tasks(id),
      selectors TEXT,
      context TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_learnings_category ON learnings(category);
    CREATE INDEX IF NOT EXISTS idx_learnings_site_id ON learnings(site_id);
    CREATE INDEX IF NOT EXISTS idx_learnings_confidence ON learnings(confidence);
    CREATE INDEX IF NOT EXISTS idx_learnings_active ON learnings(is_active);
  `);

  // Unique index for deduplication (pattern_key + site_id)
  try {
    db.exec('CREATE UNIQUE INDEX idx_learnings_pattern_key_site ON learnings(pattern_key, site_id)');
  } catch {
    // Index already exists
  }

  // Phase 7 migrations — Self-learning (negative learnings)
  addColumnIfMissing(db, 'learnings', 'polarity', "TEXT NOT NULL DEFAULT 'positive'");

  // Phase 8 migrations — WhatsApp image support
  addColumnIfMissing(db, 'tasks', 'reference_image_path', 'TEXT');

  // Phase 9 migrations — Task retry tracking
  addColumnIfMissing(db, 'tasks', 'attempt_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'tasks', 'last_error', 'TEXT');

  // Phase 10 migrations — Dashboard chat support
  addColumnIfMissing(db, 'whatsapp_messages', 'source', "TEXT NOT NULL DEFAULT 'whatsapp'");

  // Phase 11 migrations — Agent event persistence (dashboard history)
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      event_type TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_agent_events_task ON agent_events(task_id);
    CREATE INDEX IF NOT EXISTS idx_agent_events_type ON agent_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_agent_events_created ON agent_events(created_at);
  `);

  // Phase 12 migrations — Original message for planning detection
  addColumnIfMissing(db, 'conversations', 'original_message', 'TEXT');

  // Phase 13 migrations — Dynamic template discovery cache
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

  // Phase 14 migrations — Granular per-operation tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS plan_operations (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      task_id TEXT,
      operation_index INTEGER NOT NULL,
      operation_type TEXT NOT NULL,
      target_page TEXT,
      placement TEXT,
      content_strategy TEXT,
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_plan_ops_conversation ON plan_operations(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_plan_ops_task ON plan_operations(task_id);
    CREATE INDEX IF NOT EXISTS idx_plan_ops_status ON plan_operations(status);
  `);

  // Phase 15 migrations — Multi-image support
  addColumnIfMissing(db, 'tasks', 'image_paths', 'TEXT');

  // Phase 16 migrations — Page ID cache for simple edit fast path
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

  // Phase 17 migrations — Template section registry (maps category+templateName → sectionId per site)
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

  // Phase 18 migrations — User memory (cross-conversation preferences)
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      category TEXT NOT NULL,
      site_id TEXT,
      tags TEXT,
      source TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_user_memories_site ON user_memories(site_id);
    CREATE INDEX IF NOT EXISTS idx_user_memories_category ON user_memories(category);
    CREATE INDEX IF NOT EXISTS idx_user_memories_active ON user_memories(active);
  `);

  // Unique index for deduplication (content + site_id)
  try {
    db.exec('CREATE UNIQUE INDEX idx_user_memories_content_site ON user_memories(content, site_id)');
  } catch {
    // Index already exists
  }

  logger.debug('Database migrations applied');
}

/**
 * Add a column to a table if it doesn't already exist.
 * SQLite doesn't support IF NOT EXISTS for ALTER TABLE,
 * so we catch the "duplicate column" error.
 */
function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    logger.debug({ table, column }, 'Migration: added column');
  } catch (err) {
    // Column already exists — ignore
    const msg = errMsg(err);
    if (!msg.includes('duplicate column')) {
      throw err;
    }
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Database closed');
  }
}
