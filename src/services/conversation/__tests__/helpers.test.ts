import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task } from '../../../models/task.js';

// Mock file-manager before importing helpers
vi.mock('../../file-manager.js', () => ({
  resolveAttachmentPath: vi.fn(),
}));

import { buildTaskDescription, describeTask, diagnoseFailure } from '../helpers.js';
import { resolveAttachmentPath } from '../../file-manager.js';

const mockedResolveAttachmentPath = vi.mocked(resolveAttachmentPath);

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    taskType: 'general_edit',
    clientName: 'Test Client',
    siteId: 'test-site',
    targetPage: 'about',
    applyToAllSites: false,
    needsClarification: false,
    status: 'pending',
    attemptCount: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedResolveAttachmentPath.mockReturnValue(undefined);
});

// ── buildTaskDescription ─────────────────────────────────────────────────────

describe('buildTaskDescription', () => {
  it('uses description field when present', () => {
    const task = makeTask({ description: 'Update the hero image on the homepage' });
    const result = buildTaskDescription(task);
    expect(result).toBe('Update the hero image on the homepage');
  });

  it('appends attachment path when provided', () => {
    mockedResolveAttachmentPath.mockReturnValue('/storage/uploads/menu.pdf');
    const task = makeTask({
      description: 'Upload the new menu',
      attachmentFilename: 'menu.pdf',
    });
    const result = buildTaskDescription(task);
    expect(result).toContain('Upload the new menu');
    expect(result).toContain('/storage/uploads/menu.pdf');
    expect(result).toContain('menu.pdf');
  });

  it('does not append attachment when resolveAttachmentPath returns undefined', () => {
    mockedResolveAttachmentPath.mockReturnValue(undefined);
    const task = makeTask({
      description: 'Upload the new menu',
      attachmentFilename: 'menu.pdf',
    });
    const result = buildTaskDescription(task);
    expect(result).toBe('Upload the new menu');
  });

  it('appends contentToFind when not already in description', () => {
    const task = makeTask({
      description: 'Remove some old content from the page',
      contentToFind: 'Summer Sale Banner',
    });
    const result = buildTaskDescription(task);
    expect(result).toContain('Content to look for: "Summer Sale Banner"');
  });

  it('does not append contentToFind when already in description (case-insensitive)', () => {
    const task = makeTask({
      description: 'Remove the Summer Sale Banner from the page',
      contentToFind: 'summer sale banner',
    });
    const result = buildTaskDescription(task);
    expect(result).not.toContain('Content to look for');
  });

  it('appends contentToAdd when not already in description', () => {
    const task = makeTask({
      description: 'Add new content to the about page',
      contentToAdd: 'Welcome to our studio',
    });
    const result = buildTaskDescription(task);
    expect(result).toContain('Content to add: "Welcome to our studio"');
  });

  it('does not append contentToAdd when already in description (case-insensitive)', () => {
    const task = makeTask({
      description: 'Add "Welcome to our studio" to the page',
      contentToAdd: 'welcome to our studio',
    });
    const result = buildTaskDescription(task);
    expect(result).not.toContain('Content to add');
  });

  it('builds from structured fields for remove_content task type', () => {
    const task = makeTask({
      taskType: 'remove_content',
      contentToFind: 'Old testimonial',
      description: undefined,
    });
    const result = buildTaskDescription(task);
    expect(result).toContain('Old testimonial');
    expect(result).toContain('remove');
    expect(result).toContain('Remove');
  });

  it('builds from structured fields for add_content task type', () => {
    const task = makeTask({
      taskType: 'add_content',
      contentToAdd: 'New paragraph about services',
      description: undefined,
    });
    const result = buildTaskDescription(task);
    expect(result).toContain('New paragraph about services');
    expect(result).toContain('Add');
  });

  it('builds from structured fields for upload_file_and_link', () => {
    const task = makeTask({
      taskType: 'upload_file_and_link',
      attachmentFilename: 'brochure.pdf',
      attachmentPath: '/storage/uploads/brochure.pdf',
      description: undefined,
    });
    const result = buildTaskDescription(task);
    expect(result).toContain('brochure.pdf');
    expect(result).toContain('/storage/uploads/brochure.pdf');
    expect(result).toContain('Upload');
  });

  it('builds upload_file_and_link without path when attachmentPath is missing', () => {
    mockedResolveAttachmentPath.mockReturnValue(undefined);
    const task = makeTask({
      taskType: 'upload_file_and_link',
      attachmentFilename: 'brochure.pdf',
      attachmentPath: undefined,
      description: undefined,
    });
    const result = buildTaskDescription(task);
    expect(result).toContain('brochure.pdf');
    expect(result).toContain('Upload');
    expect(result).not.toContain('located at');
  });

  it('builds from structured fields for update_menu_block', () => {
    const task = makeTask({
      taskType: 'update_menu_block',
      contentToAdd: 'New appetizer section',
      description: undefined,
    });
    const result = buildTaskDescription(task);
    expect(result).toContain('menu block');
    expect(result).toContain('New appetizer section');
  });

  it('builds update_menu_block without contentToAdd', () => {
    const task = makeTask({
      taskType: 'update_menu_block',
      description: undefined,
    });
    const result = buildTaskDescription(task);
    expect(result).toContain('menu block');
    expect(result).toContain('Update');
  });

  it('builds from structured fields for replace_file', () => {
    const task = makeTask({
      taskType: 'replace_file',
      attachmentFilename: 'new-menu.pdf',
      attachmentPath: '/storage/uploads/new-menu.pdf',
      description: undefined,
    });
    const result = buildTaskDescription(task);
    expect(result).toContain('new-menu.pdf');
    expect(result).toContain('/storage/uploads/new-menu.pdf');
    expect(result).toContain('Replace');
  });

  it('handles unknown task type with fallback description', () => {
    const task = makeTask({
      taskType: 'general_edit',
      description: undefined,
    });
    const result = buildTaskDescription(task);
    expect(result).toContain('general_edit');
    expect(result).toContain('Perform');
  });

  it('handles empty/missing fields gracefully', () => {
    const task = makeTask({
      description: undefined,
      contentToFind: undefined,
      contentToAdd: undefined,
      attachmentFilename: undefined,
    });
    const result = buildTaskDescription(task);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('appends both contentToFind and contentToAdd when both present and not in description', () => {
    const task = makeTask({
      description: 'Make some changes to the page',
      contentToFind: 'Old heading',
      contentToAdd: 'New heading',
    });
    const result = buildTaskDescription(task);
    expect(result).toContain('Content to look for: "Old heading"');
    expect(result).toContain('Content to add: "New heading"');
  });
});

// ── describeTask ─────────────────────────────────────────────────────────────

describe('describeTask', () => {
  it('truncates descriptions longer than 80 chars', () => {
    const longDesc = 'A'.repeat(100);
    const task = makeTask({ description: longDesc });
    const result = describeTask(task);
    expect(result).toContain('A'.repeat(80));
    expect(result).toContain('...');
  });

  it('does not truncate descriptions 80 chars or shorter', () => {
    const desc = 'A'.repeat(80);
    const task = makeTask({ description: desc });
    const result = describeTask(task);
    expect(result).not.toContain('...');
  });

  it('includes site name and page info', () => {
    const task = makeTask({
      description: 'Update the hero image',
      siteId: 'acme-corp',
      targetPage: 'homepage',
    });
    const result = describeTask(task);
    expect(result).toContain('acme-corp');
    expect(result).toContain('/homepage');
  });

  it('omits site name when siteId is "unknown"', () => {
    const task = makeTask({
      description: 'Update something',
      siteId: 'unknown',
    });
    const result = describeTask(task);
    expect(result).not.toContain('unknown');
  });

  it('omits page when targetPage is undefined', () => {
    const task = makeTask({
      description: 'Update something',
      siteId: 'test-site',
      targetPage: undefined,
    });
    const result = describeTask(task);
    expect(result).not.toContain('/');
  });

  it('handles legacy format without description (remove_content)', () => {
    const task = makeTask({
      description: undefined,
      taskType: 'remove_content',
      contentToFind: 'Old banner',
      siteId: 'my-site',
      targetPage: 'home',
    });
    const result = describeTask(task);
    expect(result).toContain('Remove');
    expect(result).toContain('Old banner');
    expect(result).toContain('my-site');
    expect(result).toContain('home');
  });

  it('handles legacy format for add_content', () => {
    const task = makeTask({
      description: undefined,
      taskType: 'add_content',
      contentToFind: 'New section',
      siteId: 'my-site',
      targetPage: 'about',
    });
    const result = describeTask(task);
    expect(result).toContain('Add');
  });

  it('handles legacy format for upload_file_and_link', () => {
    const task = makeTask({
      description: undefined,
      taskType: 'upload_file_and_link',
      attachmentFilename: 'menu.pdf',
      siteId: 'my-site',
      targetPage: 'menu',
    });
    const result = describeTask(task);
    expect(result).toContain('Upload');
    expect(result).toContain('menu.pdf');
  });

  it('handles legacy format for update_menu_block', () => {
    const task = makeTask({
      description: undefined,
      taskType: 'update_menu_block',
      contentToFind: 'Dinner menu',
      siteId: 'restaurant-site',
      targetPage: 'menu',
    });
    const result = describeTask(task);
    expect(result).toContain('Update menu');
  });

  it('handles legacy format for replace_file', () => {
    const task = makeTask({
      description: undefined,
      taskType: 'replace_file',
      attachmentFilename: 'updated-doc.pdf',
      siteId: 'my-site',
      targetPage: 'resources',
    });
    const result = describeTask(task);
    expect(result).toContain('Replace');
  });

  it('appends all-sites indicator when applyToAllSites is true', () => {
    const task = makeTask({
      description: undefined,
      taskType: 'remove_content',
      contentToFind: 'Banner',
      applyToAllSites: true,
      groupId: 'franchise',
    });
    const result = describeTask(task);
    expect(result).toContain('all franchise sites');
  });

  it('returns reasonable output for minimal task data', () => {
    const task = makeTask({
      description: undefined,
      taskType: 'general_edit',
      siteId: 'unknown',
      targetPage: undefined,
      contentToFind: undefined,
      attachmentFilename: undefined,
    });
    const result = describeTask(task);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    // Falls through to the default case which uses taskType directly
    expect(result).toContain('general_edit');
  });
});

// ── diagnoseFailure ──────────────────────────────────────────────────────────

describe('diagnoseFailure', () => {
  it('maps "unknown site" errors to permission/invite message', () => {
    const task = makeTask({ clientName: 'Acme Corp', siteId: 'acme-corp' });
    const result = diagnoseFailure('Unknown site: acme-corp', task);
    expect(result).toContain('Acme Corp');
    expect(result).toContain('Permissions');
    expect(result).toContain('user@example.com');
  });

  it('maps "site not found" errors to permission/invite message', () => {
    const task = makeTask({ clientName: 'Acme Corp', siteId: 'acme-corp' });
    const result = diagnoseFailure('Site not found in configuration', task);
    expect(result).toContain('Acme Corp');
    expect(result).toContain('contributor');
  });

  it('uses siteId when clientName is missing', () => {
    const task = makeTask({ clientName: '', siteId: 'acme-corp' });
    const result = diagnoseFailure('Unknown site: acme-corp', task);
    expect(result).toContain('acme-corp');
  });

  it('maps "login" errors to re-auth message', () => {
    const task = makeTask();
    const result = diagnoseFailure('Login required: please sign in', task);
    expect(result).toContain('login');
    expect(result).toContain('expired');
    expect(result).toContain('Login required: please sign in');
  });

  it('maps "sign in" errors to re-auth message', () => {
    const task = makeTask();
    const result = diagnoseFailure('You need to sign in first', task);
    expect(result).toContain('login');
  });

  it('maps "authentication" errors to re-auth message', () => {
    const task = makeTask();
    const result = diagnoseFailure('Authentication failed', task);
    expect(result).toContain('login');
  });

  it('maps "password" errors to re-auth message', () => {
    const task = makeTask();
    const result = diagnoseFailure('Invalid password', task);
    expect(result).toContain('login');
  });

  it('maps "timeout" errors to retry message', () => {
    const task = makeTask();
    const result = diagnoseFailure('Navigation timeout exceeded 30000ms', task);
    expect(result).toContain('too long to load');
    expect(result).toContain('Navigation timeout exceeded 30000ms');
  });

  it('maps "timed out" errors to retry message', () => {
    const task = makeTask();
    const result = diagnoseFailure('Request timed out waiting for selector', task);
    expect(result).toContain('too long to load');
  });

  it('maps "404" errors to page not found message', () => {
    const task = makeTask({ targetPage: 'services', clientName: 'My Client', siteId: 'my-site' });
    const result = diagnoseFailure('Received 404 when loading page', task);
    expect(result).toContain('services');
    expect(result).toContain('My Client');
  });

  it('maps "page not found" errors to page not found message', () => {
    const task = makeTask({ targetPage: 'about-us' });
    const result = diagnoseFailure('Page not found in navigation', task);
    expect(result).toContain('about-us');
  });

  it('maps "no page" errors to page not found message', () => {
    const task = makeTask({ targetPage: 'portfolio' });
    const result = diagnoseFailure('No page matched the given slug', task);
    expect(result).toContain('portfolio');
  });

  it('returns original error message for unknown patterns', () => {
    const task = makeTask();
    const errorMsg = 'Something unexpected went wrong with the widget';
    const result = diagnoseFailure(errorMsg, task);
    expect(result).toBe(errorMsg);
  });

  it('uses "unknown" when targetPage is undefined on 404 errors', () => {
    const task = makeTask({ targetPage: undefined });
    const result = diagnoseFailure('404 error', task);
    expect(result).toContain('unknown');
  });

  it('handles empty error string gracefully', () => {
    const task = makeTask();
    const result = diagnoseFailure('', task);
    expect(typeof result).toBe('string');
  });
});
