import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/database.js';
import { logger } from '../utils/logger.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => {
    const checks: Record<string, unknown> = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };

    // ── Database check ──────────────────────────────────────────────────
    try {
      const db = getDb();

      // Quick connectivity test
      const dbTest = db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
      checks.database = dbTest?.ok === 1 ? 'ok' : 'error';

      // Pending/executing task counts
      const taskCounts = db
        .prepare(
          `SELECT
             SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
             SUM(CASE WHEN status = 'executing' THEN 1 ELSE 0 END) AS executing,
             SUM(CASE WHEN status = 'failed' AND updated_at > datetime('now', '-1 hour') THEN 1 ELSE 0 END) AS failed_last_hour,
             COUNT(*) AS total
           FROM tasks`,
        )
        .get() as { pending: number; executing: number; failed_last_hour: number; total: number } | undefined;

      checks.tasks = {
        pending: taskCounts?.pending ?? 0,
        executing: taskCounts?.executing ?? 0,
        failedLastHour: taskCounts?.failed_last_hour ?? 0,
        total: taskCounts?.total ?? 0,
      };

      // Active conversation count
      const activeConvos = db
        .prepare(
          `SELECT COUNT(*) AS count FROM conversations
           WHERE status NOT IN ('completed', 'rejected')`,
        )
        .get() as { count: number } | undefined;
      checks.activeConversations = activeConvos?.count ?? 0;

      // Learning stats
      const learningStats = db
        .prepare(
          `SELECT
             COUNT(*) AS active,
             ROUND(AVG(confidence), 2) AS avg_confidence
           FROM learnings WHERE is_active = 1`,
        )
        .get() as { active: number; avg_confidence: number } | undefined;
      checks.learnings = {
        active: learningStats?.active ?? 0,
        avgConfidence: learningStats?.avg_confidence ?? 0,
      };
    } catch (err) {
      checks.database = 'error';
      checks.databaseError = String(err);
      checks.status = 'degraded';
      logger.warn({ error: err }, 'Health check: database error');
    }

    return checks;
  });
}
