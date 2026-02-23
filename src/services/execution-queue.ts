/**
 * Execution queue — ensures browser tasks for the SAME site run serially,
 * while tasks for DIFFERENT sites can execute in parallel.
 *
 * Multiple conversations can be in 'executing' status simultaneously. Browser
 * work is serialised per-site to avoid Squarespace session conflicts (two agents
 * editing the same site would corrupt the editor state). Tasks targeting
 * different sites run concurrently — each gets its own browser context.
 */

import { logger } from '../utils/logger.js';
import { errMsg } from '../utils/errors.js';

interface QueueItem {
  conversationId: string;
  siteId: string;
  executeFn: () => Promise<void>;
  enqueuedAt: string;
}

interface SiteQueue {
  running: QueueItem | null;
  queue: QueueItem[];
}

class ExecutionQueue {
  private siteQueues: Map<string, SiteQueue> = new Map();

  /**
   * Add a conversation's execution to the queue.
   * Tasks are keyed by siteId — different sites execute in parallel,
   * same-site tasks are serialised.
   */
  enqueue(conversationId: string, siteId: string, executeFn: () => Promise<void>): void {
    // Check if this conversation is already queued or running on any site queue
    for (const [, sq] of this.siteQueues) {
      if (sq.running?.conversationId === conversationId ||
          sq.queue.some((item) => item.conversationId === conversationId)) {
        logger.warn({ conversationId, siteId }, 'Conversation already queued or running, skipping');
        return;
      }
    }

    let siteQueue = this.siteQueues.get(siteId);
    if (!siteQueue) {
      siteQueue = { running: null, queue: [] };
      this.siteQueues.set(siteId, siteQueue);
    }

    siteQueue.queue.push({ conversationId, siteId, executeFn, enqueuedAt: new Date().toISOString() });

    logger.info({
      conversationId,
      siteId,
      siteQueueLength: siteQueue.queue.length,
      siteRunning: !!siteQueue.running,
      activeSites: this.getActiveSiteCount(),
    }, 'Conversation enqueued for execution');

    this.emitQueueUpdate();
    this.processNext(siteId);
  }

  private async processNext(siteId: string): Promise<void> {
    const siteQueue = this.siteQueues.get(siteId);
    if (!siteQueue || siteQueue.running) return;

    const next = siteQueue.queue.shift();
    if (!next) {
      // Clean up empty site queues
      this.siteQueues.delete(siteId);
      return;
    }

    siteQueue.running = next;
    logger.info({
      conversationId: next.conversationId,
      siteId,
      activeSites: this.getActiveSiteCount(),
    }, 'Execution queue: starting');
    this.emitQueueUpdate();

    try {
      await next.executeFn();
    } catch (err) {
      logger.error({ conversationId: next.conversationId, siteId, error: errMsg(err) }, 'Queued execution failed');
    } finally {
      siteQueue.running = null;
      logger.info({
        conversationId: next.conversationId,
        siteId,
        remaining: siteQueue.queue.length,
      }, 'Execution queue: finished');
      this.emitQueueUpdate();
      this.processNext(siteId);
    }
  }

  // ─── Status Accessors ──────────────────────────────────────────────────

  /** True if any site queue has a running task. */
  isRunning(): boolean {
    for (const [, sq] of this.siteQueues) {
      if (sq.running) return true;
    }
    return false;
  }

  /** Number of sites with actively running tasks. */
  getActiveSiteCount(): number {
    let count = 0;
    for (const [, sq] of this.siteQueues) {
      if (sq.running) count++;
    }
    return count;
  }

  /** Total queued (waiting) items across all site queues. */
  getQueueLength(): number {
    let total = 0;
    for (const [, sq] of this.siteQueues) {
      total += sq.queue.length;
    }
    return total;
  }

  /** First running conversation ID (backwards compat for dashboard). */
  getRunningConversationId(): string | null {
    for (const [, sq] of this.siteQueues) {
      if (sq.running) return sq.running.conversationId;
    }
    return null;
  }

  /** All currently running conversation IDs (one per active site). */
  getRunningConversationIds(): string[] {
    const ids: string[] = [];
    for (const [, sq] of this.siteQueues) {
      if (sq.running) ids.push(sq.running.conversationId);
    }
    return ids;
  }

  /** All queued (waiting) conversation IDs across all site queues. */
  getQueuedConversationIds(): string[] {
    const ids: string[] = [];
    for (const [, sq] of this.siteQueues) {
      for (const item of sq.queue) {
        ids.push(item.conversationId);
      }
    }
    return ids;
  }

  /** Get per-site queue status for dashboard display. */
  getSiteQueueStatus(): Array<{ siteId: string; running: string | null; queued: string[] }> {
    const status: Array<{ siteId: string; running: string | null; queued: string[] }> = [];
    for (const [siteId, sq] of this.siteQueues) {
      status.push({
        siteId,
        running: sq.running?.conversationId ?? null,
        queued: sq.queue.map((q) => q.conversationId),
      });
    }
    return status;
  }

  private emitQueueUpdate(): void {
    import('./dashboard-events.js').then(({ dashboardEvents }) => {
      dashboardEvents.emit('dashboard', {
        type: 'conversation_update' as const,
        data: {
          queueRunning: this.getRunningConversationId(),
          queueRunningAll: this.getRunningConversationIds(),
          queueWaiting: this.getQueuedConversationIds(),
          queueLength: this.getQueueLength(),
          activeSites: this.getActiveSiteCount(),
          siteQueues: this.getSiteQueueStatus(),
        },
        timestamp: new Date().toISOString(),
      });
    }).catch(() => {});
  }
}

export const executionQueue = new ExecutionQueue();
