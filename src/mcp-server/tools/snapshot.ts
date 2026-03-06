import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getClient, resolvePageIds } from '../session.js';
import { saveSnapshot, listSnapshots, getSnapshot, deleteSnapshot } from '../../services/snapshot.js';

export function registerSnapshotTools(server: McpServer) {
  // ── sq_snapshot_section ─────────────────────────────────────────────────────
  server.registerTool('sq_snapshot_section', {
    description: 'Save a manual snapshot of a page\'s current sections for undo/recovery.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      label: z.string().optional().describe('Optional label for this snapshot'),
    },
  }, async ({ siteId, pageSlug, label }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const data = await client.getPageSections(ids.pageSectionsId);
      const id = saveSnapshot({
        siteId,
        pageSectionsId: ids.pageSectionsId,
        collectionId: ids.collectionId,
        sections: data.sections,
        label,
        isAuto: false,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: true,
          snapshotId: id,
          label: label ?? null,
          sectionCount: data.sections.length,
        }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_list_snapshots ───────────────────────────────────────────────────────
  server.registerTool('sq_list_snapshots', {
    description: 'List saved section snapshots for a site, optionally filtered by page.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().optional().describe('Filter by page slug'),
      limit: z.number().optional().describe('Max results (default 20)'),
    },
  }, async ({ siteId, pageSlug, limit }) => {
    try {
      let pageSectionsId: string | undefined;
      if (pageSlug) {
        const ids = await resolvePageIds(siteId, pageSlug);
        if (!ids) {
          return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
        }
        pageSectionsId = ids.pageSectionsId;
      }
      const snapshots = listSnapshots({
        siteId,
        pageSectionsId,
        limit: limit ?? 20,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(snapshots, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_restore_snapshot ─────────────────────────────────────────────────────
  server.registerTool('sq_restore_snapshot', {
    description: 'Restore a previously saved snapshot, replacing the current page sections. Auto-snapshots current state before restoring.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      snapshotId: z.number().describe('Snapshot ID to restore'),
    },
  }, async ({ siteId, snapshotId }) => {
    try {
      const snapshot = getSnapshot(snapshotId);
      if (!snapshot) {
        return { content: [{ type: 'text' as const, text: `Error: Snapshot ${snapshotId} not found` }], isError: true };
      }
      const client = getClient(siteId);
      // Fetch current state — this triggers auto-snapshot of current state via the hook
      await client.getPageSections(snapshot.pageSectionsId);

      const collectionId = snapshot.collectionId;
      if (!collectionId) {
        return { content: [{ type: 'text' as const, text: 'Error: Snapshot has no collectionId — cannot restore' }], isError: true };
      }

      const result = await client.savePageSections(
        snapshot.pageSectionsId,
        collectionId,
        snapshot.sections as Parameters<typeof client.savePageSections>[2],
      );

      if (!result.success) {
        return { content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to restore snapshot'}` }], isError: true };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: true,
          restoredSnapshotId: snapshotId,
          sectionCount: snapshot.sections.length,
        }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_delete_snapshot ──────────────────────────────────────────────────────
  server.registerTool('sq_delete_snapshot', {
    description: 'Delete a saved section snapshot.',
    inputSchema: {
      snapshotId: z.number().describe('Snapshot ID to delete'),
    },
  }, async ({ snapshotId }) => {
    try {
      const success = deleteSnapshot(snapshotId);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });
}
