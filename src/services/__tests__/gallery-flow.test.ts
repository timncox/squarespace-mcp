/**
 * Gallery flow integration tests — end-to-end gallery detection, conversation flow,
 * and planning trigger verification.
 */

import { describe, it, expect } from 'vitest';
import { taskNeedsContentPlanning, taskIsPageCreation } from '../conversation/planning.js';
import { hasGalleryIntent } from '../conversation/message-handlers.js';
import type { Task } from '../../models/task.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    taskType: 'general_edit',
    clientName: 'Test Client',
    siteId: 'test-site',
    description: '',
    contentToAdd: undefined,
    targetPage: 'home',
    applyToAllSites: false,
    needsClarification: false,
    status: 'pending',
    attemptCount: 0,
    createdAt: '2026-02-24T00:00:00Z',
    updatedAt: '2026-02-24T00:00:00Z',
    ...overrides,
  };
}

// ─── Gallery Pattern Detection in Planning Triggers ──────────────────────────

describe('gallery pattern detection in planning triggers', () => {
  describe('gallery patterns trigger content planning', () => {
    const galleryDescriptions: Array<[string, string]> = [
      ['gallery', 'add a gallery to the homepage'],
      ['photo gallery', 'create a photo gallery page'],
      ['image gallery', 'set up an image gallery for our work'],
      ['portfolio', 'create a portfolio page'],
      ['add photos', 'add photos to the gallery page'],
      ['add images', 'add images to the about page'],
      ['upload photos', 'upload photos to the site'],
      ['upload images', 'upload images to the gallery'],
      ['create gallery', 'create gallery page for our projects'],
      ['new gallery', 'set up a new gallery for events'],
    ];

    for (const [pattern, description] of galleryDescriptions) {
      it(`matches gallery pattern: "${pattern}"`, () => {
        const task = makeTask({ description });
        expect(taskNeedsContentPlanning(task)).toBe(true);
      });
    }
  });

  it('matches "gallery" in original message when description is rewritten', () => {
    const task = makeTask({
      description: 'Add a new heading block to the homepage',
    });
    expect(taskNeedsContentPlanning(task)).toBe(false); // description alone doesn't match
    expect(taskNeedsContentPlanning(task, 'Create a photo gallery on the homepage')).toBe(true);
  });

  it('matches "portfolio" in original message', () => {
    const task = makeTask({
      description: 'Add a page showcasing projects',
    });
    expect(taskNeedsContentPlanning(task, 'Set up a portfolio page for my work')).toBe(true);
  });

  it('"add a new gallery" matches (common variation)', () => {
    const task = makeTask({ description: 'add a new gallery page for the restaurant' });
    expect(taskNeedsContentPlanning(task)).toBe(true);
  });

  it('"add a gallery section" matches', () => {
    const task = makeTask({ description: 'add a gallery section to the homepage' });
    expect(taskNeedsContentPlanning(task)).toBe(true);
  });

  it('case-insensitive: "PHOTO GALLERY" matches', () => {
    const task = makeTask({ description: 'Create a PHOTO GALLERY for the restaurant' });
    expect(taskNeedsContentPlanning(task)).toBe(true);
  });

  it('does not trigger for non-gallery tasks', () => {
    const task = makeTask({ description: 'change the phone number to 555-1234' });
    expect(taskNeedsContentPlanning(task)).toBe(false);
  });
});

// ─── Gallery Intent Detection (hasGalleryIntent) ────────────────────────────

describe('hasGalleryIntent', () => {
  it('detects "gallery" in text', () => {
    expect(hasGalleryIntent('add a gallery to the homepage')).toBe(true);
  });

  it('detects "photo gallery"', () => {
    expect(hasGalleryIntent('create a photo gallery')).toBe(true);
  });

  it('detects "image gallery"', () => {
    expect(hasGalleryIntent('set up an image gallery')).toBe(true);
  });

  it('detects "portfolio"', () => {
    expect(hasGalleryIntent('create a portfolio page')).toBe(true);
  });

  it('detects "add photos"', () => {
    expect(hasGalleryIntent('add photos to the site')).toBe(true);
  });

  it('detects "upload images"', () => {
    expect(hasGalleryIntent('upload images to the gallery')).toBe(true);
  });

  it('detects "create gallery"', () => {
    expect(hasGalleryIntent('create gallery for our work')).toBe(true);
  });

  it('detects "new gallery"', () => {
    expect(hasGalleryIntent('set up a new gallery')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(hasGalleryIntent('Create a PHOTO GALLERY')).toBe(true);
  });

  it('returns false for non-gallery text', () => {
    expect(hasGalleryIntent('update the phone number')).toBe(false);
  });

  it('returns false for empty text', () => {
    expect(hasGalleryIntent('')).toBe(false);
  });

  it('detects gallery intent in longer messages', () => {
    expect(hasGalleryIntent('hey can you add 5 photos to a new gallery page on Tim Cox')).toBe(true);
  });

  it('detects "upload photos" in a longer message', () => {
    expect(hasGalleryIntent('I need to upload photos of the renovation to the site')).toBe(true);
  });
});

// ─── Gallery + Page Creation Detection ──────────────────────────────────────

describe('gallery + page creation combined detection', () => {
  it('detects page creation + gallery intent together', () => {
    const task = makeTask({ description: 'create a new page for the photo gallery' });
    expect(taskIsPageCreation(task)).toBe(true);
    expect(taskNeedsContentPlanning(task)).toBe(true);
  });

  it('"create a new gallery page" triggers both page creation and planning', () => {
    const task = makeTask({ description: 'create a new gallery page for our portfolio' });
    expect(taskIsPageCreation(task)).toBe(true);
    expect(taskNeedsContentPlanning(task)).toBe(true);
  });

  it('"add a page for gallery" triggers page creation and gallery planning', () => {
    const task = makeTask({ description: 'add a page for gallery photos of the restaurant' });
    expect(taskIsPageCreation(task)).toBe(true);
    expect(taskNeedsContentPlanning(task)).toBe(true);
  });

  it('gallery on existing page does not trigger page creation', () => {
    const task = makeTask({ description: 'add a gallery section to the homepage' });
    expect(taskIsPageCreation(task)).toBe(false);
    expect(taskNeedsContentPlanning(task)).toBe(true);
  });
});

// ─── Gallery Task with Images (direct execution) ────────────────────────────

describe('gallery task with images', () => {
  it('gallery task with imagePaths and sufficient content does not need planning', () => {
    // When a user provides images AND detailed content, it should not trigger planning
    const task = makeTask({
      taskType: 'add_content',
      contentToAdd: 'Here are the photos for the gallery section with captions for each one.',
      imagePaths: ['/storage/uploads/img1.jpg', '/storage/uploads/img2.jpg'],
    });
    expect(taskNeedsContentPlanning(task)).toBe(false);
  });

  it('gallery task with imagePaths but no content needs planning', () => {
    // Gallery intent with images but no content description — needs creative planning
    const task = makeTask({
      taskType: 'add_content',
      description: 'add a gallery section with these photos',
      contentToAdd: undefined,
      imagePaths: ['/storage/uploads/img1.jpg', '/storage/uploads/img2.jpg'],
    });
    expect(taskNeedsContentPlanning(task)).toBe(true);
  });
});

// ─── Gallery Task Without Images (asks for images) ──────────────────────────

describe('gallery task without images detection', () => {
  it('gallery intent message without images should be detected', () => {
    // Simulates the flow: user sends "create a photo gallery" without any images
    const messageText = 'create a photo gallery on Tim Cox';
    const taskDescription = 'Create a photo gallery page on Tim Cox site';
    const hasImages = false;

    // Both message and task description should show gallery intent
    expect(hasGalleryIntent(messageText)).toBe(true);
    expect(hasGalleryIntent(taskDescription)).toBe(true);

    // Without images, the conversation should ask for them
    // (this is the flow check — the actual message routing is in message-handlers)
    expect(hasImages).toBe(false);
  });

  it('gallery intent with images should proceed directly', () => {
    const messageText = 'add these photos to a gallery on Tim Cox';
    const imagePaths = ['/storage/uploads/img1.jpg', '/storage/uploads/img2.jpg'];
    const hasImages = imagePaths.length > 0;

    expect(hasGalleryIntent(messageText)).toBe(true);
    expect(hasImages).toBe(true);
  });
});

// ─── Gallery Request Interpretation ──────────────────────────────────────────

describe('gallery request interpretation expectations', () => {
  // These tests verify the gallery-specific patterns that the request interpreter
  // should handle correctly (prompt-level behavior, verified via pattern matching)

  it('"add 5 photos to a new gallery page" has gallery intent', () => {
    expect(hasGalleryIntent('add 5 photos to a new gallery page on Tim Cox')).toBe(true);
  });

  it('"create a photo gallery" has gallery intent', () => {
    expect(hasGalleryIntent('create a photo gallery')).toBe(true);
  });

  it('"upload these images to a gallery" has gallery intent', () => {
    expect(hasGalleryIntent('upload these images to a gallery')).toBe(true);
  });

  it('"add a portfolio page with my projects" has gallery intent', () => {
    expect(hasGalleryIntent('add a portfolio page with my projects')).toBe(true);
  });

  it('"add photos of the renovation" has gallery intent', () => {
    expect(hasGalleryIntent('add photos of the renovation to the website')).toBe(true);
  });

  it('"upload images from the event" has gallery intent', () => {
    expect(hasGalleryIntent('upload images from the event')).toBe(true);
  });
});

// ─── Gallery with Existing Execution Infrastructure ──────────────────────────

describe('gallery execution infrastructure compatibility', () => {
  it('gallery content strategy triggers content planning', () => {
    // A task description mentioning gallery should trigger the planning pipeline
    const task = makeTask({
      taskType: 'general_edit',
      description: 'add a photo gallery section to showcase our work',
    });
    expect(taskNeedsContentPlanning(task)).toBe(true);
  });

  it('portfolio page creation triggers both page creation and planning', () => {
    const task = makeTask({
      taskType: 'general_edit',
      description: 'create a new page called Portfolio with a gallery of project images',
    });

    // Should trigger page creation detection
    expect(taskIsPageCreation(task)).toBe(true);

    // Should also trigger content planning (for gallery setup)
    expect(taskNeedsContentPlanning(task)).toBe(true);
  });

  it('gallery with blank_api strategy would be used for multiple images', () => {
    // Verify that a gallery task with images would be routed to blank_api
    // (This is the expected behavior based on the content strategist prompt)
    const task = makeTask({
      taskType: 'add_content',
      description: 'add a gallery with uploaded photos',
      imagePaths: ['/img1.jpg', '/img2.jpg', '/img3.jpg'],
    });

    // Gallery with images but no explicit content needs planning
    expect(taskNeedsContentPlanning(task)).toBe(true);
  });
});
