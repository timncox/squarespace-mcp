/**
 * Dashboard event bus — bridges outbound messages and status updates to SSE clients.
 *
 * Used by:
 * - whatsapp.ts: emits 'message', 'buttons', 'image' events after sending
 * - tasks.ts: emits 'task_update' on status change
 * - conversations.ts: emits 'conversation_update' on status change
 * - dashboard.ts (SSE endpoint): subscribes to relay events to the browser
 *
 * Agent events (agent_step, agent_activity) are persisted to SQLite for
 * dashboard history that survives page refresh.
 */

import { EventEmitter } from 'events';

export interface DashboardEvent {
  type: 'message' | 'buttons' | 'image' | 'task_update' | 'conversation_update' | 'agent_step' | 'agent_activity' | 'operation_update';
  data: Record<string, unknown>;
  timestamp: string;
}

class DashboardEventBus extends EventEmitter {}

/** Singleton event bus — import and use directly. */
export const dashboardEvents = new DashboardEventBus();

// ── Persist agent events to SQLite ───────────────────────────────────────────

const PERSIST_TYPES = new Set(['agent_step', 'agent_activity']);

dashboardEvents.on('dashboard', (evt: DashboardEvent) => {
  if (!PERSIST_TYPES.has(evt.type)) return;

  // Dynamic import to avoid circular dependency (database → logger → …)
  import('../db/agent-events.js').then(({ insertAgentEvent }) => {
    const taskId = (evt.data?.taskId as string) ?? null;
    insertAgentEvent(evt.type, taskId, evt.data);
  }).catch(() => {
    // Silently ignore — persistence is best-effort
  });
});

// ── Retention cleanup (every hour, delete events older than 7 days) ──────────

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

setInterval(() => {
  import('../db/agent-events.js').then(({ deleteOldAgentEvents }) => {
    deleteOldAgentEvents(7);
  }).catch(() => {});
}, CLEANUP_INTERVAL_MS);
