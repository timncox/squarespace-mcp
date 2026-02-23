/**
 * Conversation helpers — formatting, diagnostics, and small utilities.
 */

import { resolveAttachmentPath } from '../file-manager.js';
import type { Task } from '../../models/task.js';

// ─── Task Description Builder ───────────────────────────────────────────────

/**
 * Build a detailed task description for the browser agent from structured task fields.
 */
export function buildTaskDescription(task: Task): string {
  // If the task already has a natural language description, use it as the base
  if (task.description) {
    let desc = task.description;

    // Append attachment info if relevant
    if (task.attachmentFilename) {
      const filePath = resolveAttachmentPath(undefined, task.attachmentFilename);
      if (filePath) {
        desc += `\n\nFile to upload: ${filePath} (filename: ${task.attachmentFilename})`;
      }
    }

    // Append specific content references
    if (task.contentToFind && !desc.toLowerCase().includes(task.contentToFind.toLowerCase())) {
      desc += `\n\nContent to look for: "${task.contentToFind}"`;
    }
    if (task.contentToAdd && !desc.toLowerCase().includes(task.contentToAdd.toLowerCase())) {
      desc += `\n\nContent to add: "${task.contentToAdd}"`;
    }

    return desc;
  }

  // Fallback: build description from structured fields
  switch (task.taskType) {
    case 'remove_content':
      return `Find and remove the section containing "${task.contentToFind}" from the page. Click on the content to select the section, then use the Remove button in the section toolbar and confirm the deletion.`;

    case 'add_content':
      return `Add the following content to the page: "${task.contentToAdd}". Add a new text block and type the content.`;

    case 'upload_file_and_link': {
      const filePath = task.attachmentPath || resolveAttachmentPath(undefined, task.attachmentFilename ?? '');
      return `Upload the file "${task.attachmentFilename}"${filePath ? ` (located at ${filePath})` : ''} and create a link or button pointing to it on the page.`;
    }

    case 'update_menu_block':
      return `Update the menu block on the page. ${task.contentToAdd ? `New content: ${task.contentToAdd}` : 'Update with the new menu items.'}`;

    case 'replace_file': {
      const filePath = task.attachmentPath || resolveAttachmentPath(undefined, task.attachmentFilename ?? '');
      return `Replace the existing file with "${task.attachmentFilename}"${filePath ? ` (located at ${filePath})` : ''}. Find the current file link and update it.`;
    }

    default:
      return `Perform a ${task.taskType} operation on the page.`;
  }
}

// ─── Formatting ─────────────────────────────────────────────────────────────

export function formatTaskList(tasks: Task[]): string {
  return tasks
    .map((t, i) => {
      const clarify = t.needsClarification ? ' ⚠️ needs clarification' : '';
      return `${i + 1}. ${describeTask(t)}${clarify}`;
    })
    .join('\n');
}

export function formatDirectRequestTaskList(tasks: Array<{ description: string; clientName: string; targetPage?: string }>): string {
  return tasks
    .map((t, i) => `${i + 1}. ${t.description} (${t.clientName}${t.targetPage ? ` / ${t.targetPage}` : ''})`)
    .join('\n');
}

export function describeTask(task: Task): string {
  // If task has a description, use it (more natural for agent-driven tasks)
  if (task.description) {
    const site = task.siteId !== 'unknown' ? ` on ${task.siteId}` : '';
    const page = task.targetPage ? `/${task.targetPage}` : '';
    return `${task.description.substring(0, 80)}${task.description.length > 80 ? '...' : ''}${site}${page}`;
  }

  // Legacy format for structured tasks
  const action =
    task.taskType === 'remove_content'
      ? 'Remove'
      : task.taskType === 'add_content'
        ? 'Add'
        : task.taskType === 'upload_file_and_link'
          ? 'Upload'
          : task.taskType === 'update_menu_block'
            ? 'Update menu'
            : task.taskType === 'replace_file'
              ? 'Replace'
              : task.taskType;

  let desc = `${action} "${task.contentToFind || task.attachmentFilename || '?'}" on ${task.siteId}/${task.targetPage ?? '?'}`;

  if (task.applyToAllSites && task.groupId) {
    desc += ` (all ${task.groupId} sites)`;
  }

  return desc;
}

// ─── Diagnostics ────────────────────────────────────────────────────────────

/**
 * Diagnose a task failure and return an actionable message for Tim.
 * Turns generic errors into specific advice on how to fix the problem.
 */
export function diagnoseFailure(errorMessage: string, task: Task): string {
  const lowerErr = errorMessage.toLowerCase();

  // Site not found — tell Tim how to add it
  if (lowerErr.includes('unknown site') || lowerErr.includes('site not found')) {
    return `I don't have access to "${task.clientName || task.siteId}" on my Squarespace dashboard.\n\n` +
      `To fix this: open that site in Squarespace → Settings → Permissions → invite user@example.com as a contributor.\n\n` +
      `Once added, send me the request again and I'll be able to edit it.`;
  }

  // Login expired
  if (lowerErr.includes('login') || lowerErr.includes('sign in') || lowerErr.includes('password') || lowerErr.includes('authentication')) {
    return `My Squarespace login may have expired. I'll try to re-login automatically next time. If this keeps happening, the credentials in .env may need updating.\n\nOriginal error: ${errorMessage}`;
  }

  // Navigation timeout
  if (lowerErr.includes('timeout') || lowerErr.includes('timed out')) {
    return `The page took too long to load — Squarespace might be slow right now. Try again in a minute.\n\nOriginal error: ${errorMessage}`;
  }

  // Page not found
  if (lowerErr.includes('page not found') || lowerErr.includes('404') || lowerErr.includes('no page')) {
    return `Couldn't find the page "${task.targetPage || 'unknown'}" on ${task.clientName || task.siteId}. Check the page name/slug and try again.\n\nOriginal error: ${errorMessage}`;
  }

  // Default — return original error
  return errorMessage;
}
