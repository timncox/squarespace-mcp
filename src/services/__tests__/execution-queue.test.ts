import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger and dashboard events before importing the module
vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../dashboard-events.js', () => ({
  dashboardEvents: {
    emit: vi.fn(),
  },
}));

// We can't import the singleton directly because it carries state between tests.
// Instead, we'll dynamically import and get a fresh class each time.
// But the module exports a singleton, not the class. Let's work around this.

// Helper to create a deferred promise we can resolve/reject externally
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void } {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('ExecutionQueue', () => {
  // We need a fresh ExecutionQueue for each test. Since the module exports a singleton,
  // we'll re-import the module each time to get a fresh instance.
  let executionQueue: typeof import('../execution-queue.js')['executionQueue'];

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../execution-queue.js');
    executionQueue = mod.executionQueue;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Enqueue Basics ──────────────────────────────────────────────────

  describe('enqueue', () => {
    it('adds item to the correct site queue', () => {
      const d = deferred();
      executionQueue.enqueue('conv-1', 'site-a', () => d.promise);

      const status = executionQueue.getSiteQueueStatus();
      expect(status).toHaveLength(1);
      expect(status[0].siteId).toBe('site-a');
    });

    it('creates a new site queue if one does not exist', () => {
      const d = deferred();
      expect(executionQueue.getSiteQueueStatus()).toHaveLength(0);

      executionQueue.enqueue('conv-1', 'site-new', () => d.promise);

      const status = executionQueue.getSiteQueueStatus();
      expect(status).toHaveLength(1);
      expect(status[0].siteId).toBe('site-new');
      d.resolve();
    });

    it('prevents duplicate conversation enqueue (same conversation ID)', () => {
      const d = deferred();
      const fn1 = vi.fn(() => d.promise);
      const fn2 = vi.fn(() => d.promise);

      executionQueue.enqueue('conv-dup', 'site-a', fn1);
      executionQueue.enqueue('conv-dup', 'site-a', fn2);

      // Should only have 1 item (the first one running, second rejected)
      expect(executionQueue.getQueueLength()).toBe(0); // first is running, not queued
      expect(executionQueue.getRunningConversationIds()).toEqual(['conv-dup']);
      d.resolve();
    });

    it('prevents duplicate conversation enqueue across different sites', () => {
      const d = deferred();
      const fn1 = vi.fn(() => d.promise);
      const fn2 = vi.fn(() => d.promise);

      executionQueue.enqueue('conv-dup', 'site-a', fn1);
      executionQueue.enqueue('conv-dup', 'site-b', fn2);

      // conv-dup should only be on site-a (first enqueue), not site-b
      const status = executionQueue.getSiteQueueStatus();
      expect(status).toHaveLength(1);
      expect(status[0].siteId).toBe('site-a');
      expect(status[0].running).toBe('conv-dup');
      d.resolve();
    });

    it('prevents duplicate enqueue when conversation is queued (not yet running)', () => {
      const d1 = deferred();
      const d2 = deferred();
      const fn3 = vi.fn(() => Promise.resolve());

      // First enqueue starts running
      executionQueue.enqueue('conv-1', 'site-a', () => d1.promise);
      // Second enqueue goes to queue (same site, waiting)
      executionQueue.enqueue('conv-2', 'site-a', () => d2.promise);
      // Third tries to enqueue conv-2 again — should be rejected
      executionQueue.enqueue('conv-2', 'site-a', fn3);

      expect(executionQueue.getQueueLength()).toBe(1); // only conv-2 queued once
      expect(executionQueue.getQueuedConversationIds()).toEqual(['conv-2']);
      d1.resolve();
      d2.resolve();
    });

    it('different sites get separate queues', () => {
      const d1 = deferred();
      const d2 = deferred();

      executionQueue.enqueue('conv-1', 'site-a', () => d1.promise);
      executionQueue.enqueue('conv-2', 'site-b', () => d2.promise);

      const status = executionQueue.getSiteQueueStatus();
      expect(status).toHaveLength(2);

      const siteA = status.find((s) => s.siteId === 'site-a');
      const siteB = status.find((s) => s.siteId === 'site-b');
      expect(siteA?.running).toBe('conv-1');
      expect(siteB?.running).toBe('conv-2');

      d1.resolve();
      d2.resolve();
    });
  });

  // ─── Sequential Execution ────────────────────────────────────────────

  describe('sequential execution per site', () => {
    it('processes items sequentially within the same site', async () => {
      const executionOrder: string[] = [];
      const d1 = deferred();
      const d2 = deferred();

      executionQueue.enqueue('conv-1', 'site-a', async () => {
        executionOrder.push('start-1');
        await d1.promise;
        executionOrder.push('end-1');
      });

      executionQueue.enqueue('conv-2', 'site-a', async () => {
        executionOrder.push('start-2');
        await d2.promise;
        executionOrder.push('end-2');
      });

      // Only conv-1 should be running
      expect(executionOrder).toEqual(['start-1']);
      expect(executionQueue.getRunningConversationIds()).toEqual(['conv-1']);
      expect(executionQueue.getQueueLength()).toBe(1); // conv-2 waiting

      // Complete conv-1
      d1.resolve();
      await flushPromises();

      // Now conv-2 should have started
      expect(executionOrder).toEqual(['start-1', 'end-1', 'start-2']);
      expect(executionQueue.getRunningConversationIds()).toEqual(['conv-2']);

      // Complete conv-2
      d2.resolve();
      await flushPromises();

      expect(executionOrder).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
    });

    it('different sites can run concurrently', async () => {
      const executionOrder: string[] = [];
      const d1 = deferred();
      const d2 = deferred();

      executionQueue.enqueue('conv-1', 'site-a', async () => {
        executionOrder.push('start-a');
        await d1.promise;
        executionOrder.push('end-a');
      });

      executionQueue.enqueue('conv-2', 'site-b', async () => {
        executionOrder.push('start-b');
        await d2.promise;
        executionOrder.push('end-b');
      });

      // Both should be running concurrently
      expect(executionOrder).toEqual(['start-a', 'start-b']);
      expect(executionQueue.getRunningConversationIds()).toHaveLength(2);
      expect(executionQueue.getActiveSiteCount()).toBe(2);

      d1.resolve();
      d2.resolve();
      await flushPromises();

      expect(executionOrder).toContain('end-a');
      expect(executionOrder).toContain('end-b');
    });

    it('queues process next item automatically when current finishes', async () => {
      const d1 = deferred();
      const d2 = deferred();
      const d3 = deferred();
      const executed: string[] = [];

      executionQueue.enqueue('conv-1', 'site-a', async () => {
        executed.push('conv-1');
        await d1.promise;
      });
      executionQueue.enqueue('conv-2', 'site-a', async () => {
        executed.push('conv-2');
        await d2.promise;
      });
      executionQueue.enqueue('conv-3', 'site-a', async () => {
        executed.push('conv-3');
        await d3.promise;
      });

      expect(executed).toEqual(['conv-1']);
      expect(executionQueue.getQueueLength()).toBe(2);

      d1.resolve();
      await flushPromises();
      expect(executed).toEqual(['conv-1', 'conv-2']);
      expect(executionQueue.getQueueLength()).toBe(1);

      d2.resolve();
      await flushPromises();
      expect(executed).toEqual(['conv-1', 'conv-2', 'conv-3']);
      expect(executionQueue.getQueueLength()).toBe(0);

      d3.resolve();
      await flushPromises();
    });
  });

  // ─── Error Handling ──────────────────────────────────────────────────

  describe('error handling', () => {
    it('continues processing after execution failure', async () => {
      const d2 = deferred();
      const executed: string[] = [];

      executionQueue.enqueue('conv-fail', 'site-a', async () => {
        executed.push('conv-fail');
        throw new Error('Execution failed!');
      });

      executionQueue.enqueue('conv-ok', 'site-a', async () => {
        executed.push('conv-ok');
        await d2.promise;
      });

      // Let the failing task process
      await flushPromises();

      // conv-fail should have run and failed, conv-ok should have started
      expect(executed).toEqual(['conv-fail', 'conv-ok']);
      expect(executionQueue.getRunningConversationIds()).toEqual(['conv-ok']);

      d2.resolve();
      await flushPromises();
    });

    it('does not leave the queue in a broken state after error', async () => {
      executionQueue.enqueue('conv-err', 'site-a', async () => {
        throw new Error('boom');
      });

      await flushPromises();

      // Queue should be fully cleaned up
      expect(executionQueue.isRunning()).toBe(false);
      expect(executionQueue.getQueueLength()).toBe(0);
      expect(executionQueue.getSiteQueueStatus()).toHaveLength(0);
    });

    it('error in one site queue does not affect other sites', async () => {
      const dB = deferred();
      const executed: string[] = [];

      executionQueue.enqueue('conv-err', 'site-a', async () => {
        executed.push('site-a-err');
        throw new Error('site-a failed');
      });

      executionQueue.enqueue('conv-ok', 'site-b', async () => {
        executed.push('site-b-ok');
        await dB.promise;
      });

      await flushPromises();

      // site-a failed and cleaned up, site-b still running
      expect(executed).toEqual(['site-a-err', 'site-b-ok']);
      expect(executionQueue.getRunningConversationIds()).toEqual(['conv-ok']);
      expect(executionQueue.getActiveSiteCount()).toBe(1);

      dB.resolve();
      await flushPromises();
    });
  });

  // ─── Cleanup ─────────────────────────────────────────────────────────

  describe('cleanup', () => {
    it('cleans up empty queues after processing', async () => {
      executionQueue.enqueue('conv-1', 'site-a', async () => {});

      await flushPromises();

      // site-a queue should be deleted after all items processed
      expect(executionQueue.getSiteQueueStatus()).toHaveLength(0);
      expect(executionQueue.isRunning()).toBe(false);
    });

    it('keeps queue alive while items remain', async () => {
      const d1 = deferred();
      const d2 = deferred();

      executionQueue.enqueue('conv-1', 'site-a', async () => { await d1.promise; });
      executionQueue.enqueue('conv-2', 'site-a', async () => { await d2.promise; });

      d1.resolve();
      await flushPromises();

      // site-a should still exist because conv-2 is running
      const status = executionQueue.getSiteQueueStatus();
      expect(status).toHaveLength(1);
      expect(status[0].running).toBe('conv-2');

      d2.resolve();
      await flushPromises();

      // Now site-a should be cleaned up
      expect(executionQueue.getSiteQueueStatus()).toHaveLength(0);
    });
  });

  // ─── Status Accessors ────────────────────────────────────────────────

  describe('isRunning', () => {
    it('returns false when no tasks are executing', () => {
      expect(executionQueue.isRunning()).toBe(false);
    });

    it('returns true when a task is executing', () => {
      const d = deferred();
      executionQueue.enqueue('conv-1', 'site-a', () => d.promise);

      expect(executionQueue.isRunning()).toBe(true);
      d.resolve();
    });

    it('returns false after all tasks complete', async () => {
      executionQueue.enqueue('conv-1', 'site-a', async () => {});

      await flushPromises();

      expect(executionQueue.isRunning()).toBe(false);
    });
  });

  describe('getActiveSiteCount', () => {
    it('returns 0 when idle', () => {
      expect(executionQueue.getActiveSiteCount()).toBe(0);
    });

    it('counts correctly with one active site', () => {
      const d = deferred();
      executionQueue.enqueue('conv-1', 'site-a', () => d.promise);
      expect(executionQueue.getActiveSiteCount()).toBe(1);
      d.resolve();
    });

    it('counts correctly with multiple active sites', () => {
      const d1 = deferred();
      const d2 = deferred();
      const d3 = deferred();

      executionQueue.enqueue('conv-1', 'site-a', () => d1.promise);
      executionQueue.enqueue('conv-2', 'site-b', () => d2.promise);
      executionQueue.enqueue('conv-3', 'site-c', () => d3.promise);

      expect(executionQueue.getActiveSiteCount()).toBe(3);

      d1.resolve();
      d2.resolve();
      d3.resolve();
    });

    it('does not count sites that only have queued (not running) items via other sites', () => {
      // This is really testing that only "running" counts, not "queued"
      const d = deferred();
      executionQueue.enqueue('conv-1', 'site-a', () => d.promise);
      executionQueue.enqueue('conv-2', 'site-a', () => Promise.resolve());

      // Only 1 active site (site-a with conv-1 running)
      expect(executionQueue.getActiveSiteCount()).toBe(1);
      d.resolve();
    });
  });

  describe('getQueueLength', () => {
    it('returns 0 when no items are queued', () => {
      expect(executionQueue.getQueueLength()).toBe(0);
    });

    it('returns 0 when items are running (not queued)', () => {
      const d = deferred();
      executionQueue.enqueue('conv-1', 'site-a', () => d.promise);

      // Running items don't count as "queued"
      expect(executionQueue.getQueueLength()).toBe(0);
      d.resolve();
    });

    it('returns total queued items across all sites', () => {
      const d1 = deferred();
      const d2 = deferred();

      // site-a: conv-1 running, conv-2 + conv-3 queued
      executionQueue.enqueue('conv-1', 'site-a', () => d1.promise);
      executionQueue.enqueue('conv-2', 'site-a', () => Promise.resolve());
      executionQueue.enqueue('conv-3', 'site-a', () => Promise.resolve());

      // site-b: conv-4 running, conv-5 queued
      executionQueue.enqueue('conv-4', 'site-b', () => d2.promise);
      executionQueue.enqueue('conv-5', 'site-b', () => Promise.resolve());

      expect(executionQueue.getQueueLength()).toBe(3); // conv-2, conv-3, conv-5

      d1.resolve();
      d2.resolve();
    });
  });

  describe('getRunningConversationIds', () => {
    it('returns empty array when idle', () => {
      expect(executionQueue.getRunningConversationIds()).toEqual([]);
    });

    it('returns single running conversation', () => {
      const d = deferred();
      executionQueue.enqueue('conv-1', 'site-a', () => d.promise);

      expect(executionQueue.getRunningConversationIds()).toEqual(['conv-1']);
      d.resolve();
    });

    it('returns all running conversations across sites', () => {
      const d1 = deferred();
      const d2 = deferred();

      executionQueue.enqueue('conv-1', 'site-a', () => d1.promise);
      executionQueue.enqueue('conv-2', 'site-b', () => d2.promise);

      const ids = executionQueue.getRunningConversationIds();
      expect(ids).toHaveLength(2);
      expect(ids).toContain('conv-1');
      expect(ids).toContain('conv-2');

      d1.resolve();
      d2.resolve();
    });

    it('does not include queued (waiting) conversations', () => {
      const d = deferred();
      executionQueue.enqueue('conv-1', 'site-a', () => d.promise);
      executionQueue.enqueue('conv-2', 'site-a', () => Promise.resolve());

      expect(executionQueue.getRunningConversationIds()).toEqual(['conv-1']);
      d.resolve();
    });
  });

  describe('getRunningConversationId', () => {
    it('returns null when idle', () => {
      expect(executionQueue.getRunningConversationId()).toBeNull();
    });

    it('returns the first running conversation', () => {
      const d = deferred();
      executionQueue.enqueue('conv-1', 'site-a', () => d.promise);

      expect(executionQueue.getRunningConversationId()).toBe('conv-1');
      d.resolve();
    });
  });

  describe('getQueuedConversationIds', () => {
    it('returns empty array when idle', () => {
      expect(executionQueue.getQueuedConversationIds()).toEqual([]);
    });

    it('returns only queued (not running) conversation IDs', () => {
      const d = deferred();
      executionQueue.enqueue('conv-1', 'site-a', () => d.promise);
      executionQueue.enqueue('conv-2', 'site-a', () => Promise.resolve());
      executionQueue.enqueue('conv-3', 'site-a', () => Promise.resolve());

      const queued = executionQueue.getQueuedConversationIds();
      expect(queued).toEqual(['conv-2', 'conv-3']);
      expect(queued).not.toContain('conv-1'); // conv-1 is running

      d.resolve();
    });

    it('returns queued IDs across all sites', () => {
      const d1 = deferred();
      const d2 = deferred();

      executionQueue.enqueue('conv-1', 'site-a', () => d1.promise);
      executionQueue.enqueue('conv-2', 'site-a', () => Promise.resolve());
      executionQueue.enqueue('conv-3', 'site-b', () => d2.promise);
      executionQueue.enqueue('conv-4', 'site-b', () => Promise.resolve());

      const queued = executionQueue.getQueuedConversationIds();
      expect(queued).toHaveLength(2);
      expect(queued).toContain('conv-2');
      expect(queued).toContain('conv-4');

      d1.resolve();
      d2.resolve();
    });
  });

  describe('getSiteQueueStatus', () => {
    it('returns empty array when no queues exist', () => {
      expect(executionQueue.getSiteQueueStatus()).toEqual([]);
    });

    it('returns per-site status with running and queued conversations', () => {
      const d1 = deferred();
      const d2 = deferred();

      executionQueue.enqueue('conv-1', 'site-a', () => d1.promise);
      executionQueue.enqueue('conv-2', 'site-a', () => Promise.resolve());
      executionQueue.enqueue('conv-3', 'site-b', () => d2.promise);

      const status = executionQueue.getSiteQueueStatus();
      expect(status).toHaveLength(2);

      const siteA = status.find((s) => s.siteId === 'site-a')!;
      expect(siteA.running).toBe('conv-1');
      expect(siteA.queued).toEqual(['conv-2']);

      const siteB = status.find((s) => s.siteId === 'site-b')!;
      expect(siteB.running).toBe('conv-3');
      expect(siteB.queued).toEqual([]);

      d1.resolve();
      d2.resolve();
    });
  });

  // ─── Complex Scenarios ───────────────────────────────────────────────

  describe('complex scenarios', () => {
    it('handles rapid enqueue of many items to the same site', async () => {
      const executed: string[] = [];
      const deferreds = Array.from({ length: 5 }, () => deferred());

      for (let i = 0; i < 5; i++) {
        const idx = i;
        executionQueue.enqueue(`conv-${i}`, 'site-a', async () => {
          executed.push(`conv-${idx}`);
          await deferreds[idx].promise;
        });
      }

      // Only first should be running
      expect(executed).toEqual(['conv-0']);
      expect(executionQueue.getQueueLength()).toBe(4);

      // Resolve each one and verify sequential processing
      for (let i = 0; i < 5; i++) {
        deferreds[i].resolve();
        await flushPromises();
      }

      expect(executed).toEqual(['conv-0', 'conv-1', 'conv-2', 'conv-3', 'conv-4']);
      expect(executionQueue.isRunning()).toBe(false);
      expect(executionQueue.getSiteQueueStatus()).toHaveLength(0);
    });

    it('mixed concurrent + sequential across sites', async () => {
      const timeline: string[] = [];
      const dA1 = deferred();
      const dA2 = deferred();
      const dB1 = deferred();

      executionQueue.enqueue('a1', 'site-a', async () => {
        timeline.push('a1-start');
        await dA1.promise;
        timeline.push('a1-end');
      });

      executionQueue.enqueue('a2', 'site-a', async () => {
        timeline.push('a2-start');
        await dA2.promise;
        timeline.push('a2-end');
      });

      executionQueue.enqueue('b1', 'site-b', async () => {
        timeline.push('b1-start');
        await dB1.promise;
        timeline.push('b1-end');
      });

      // a1 and b1 should run concurrently; a2 waits
      expect(timeline).toEqual(['a1-start', 'b1-start']);
      expect(executionQueue.getActiveSiteCount()).toBe(2);
      expect(executionQueue.getQueueLength()).toBe(1);

      // Finish b1
      dB1.resolve();
      await flushPromises();
      expect(timeline).toContain('b1-end');

      // site-b cleaned up, site-a still has a1 running + a2 queued
      expect(executionQueue.getActiveSiteCount()).toBe(1);

      // Finish a1 → a2 starts
      dA1.resolve();
      await flushPromises();
      expect(timeline).toContain('a1-end');
      expect(timeline).toContain('a2-start');

      dA2.resolve();
      await flushPromises();
      expect(timeline).toContain('a2-end');
      expect(executionQueue.isRunning()).toBe(false);
    });

    it('can enqueue a conversation after a previous one with the same ID completed', async () => {
      // First run
      executionQueue.enqueue('conv-reuse', 'site-a', async () => {});
      await flushPromises();

      expect(executionQueue.isRunning()).toBe(false);

      // Same conversation ID, should be allowed since the first one completed
      const d = deferred();
      const fn = vi.fn(() => d.promise);
      executionQueue.enqueue('conv-reuse', 'site-a', fn);

      expect(fn).toHaveBeenCalled();
      expect(executionQueue.getRunningConversationIds()).toEqual(['conv-reuse']);

      d.resolve();
      await flushPromises();
    });
  });
});

/** Flush microtask queue to allow async processNext chains to execute */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => {
    // Use setTimeout to flush both microtasks and macrotasks
    setTimeout(resolve, 0);
  });
}
