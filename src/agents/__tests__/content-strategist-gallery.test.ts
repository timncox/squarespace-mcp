import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task } from '../../models/task.js';

// ── Mock Anthropic ─────────────────────────────────────────────────────

const mockCreate = vi.fn();
vi.mock('../../utils/anthropic-client.js', () => ({
  getAnthropicClient: () => ({
    messages: {
      create: mockCreate,
    },
  }),
}));

// ── Mock fs for template catalog ─────────────────────────────────────────

const MOCK_CATALOG = JSON.stringify([
  {
    category: 'About',
    templates: [
      {
        index: 0,
        name: 'Bio with Image',
        layout: 'text-left-image-right',
        placeholders: {
          texts: [{ default: 'About Us', role: 'heading' }],
          buttons: [],
          images: [],
        },
      },
    ],
  },
]);

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => MOCK_CATALOG),
}));

// ── Mock learnings ──────────────────────────────────────────────────────

vi.mock('../../db/learnings.js', () => ({
  getRelevantLearnings: vi.fn(() => []),
}));

// ── Mock template discovery ─────────────────────────────────────────────

vi.mock('../../services/template-discovery.js', () => ({
  formatDiscoveredTemplatesForPrompt: vi.fn(() => '### Discovered Templates\n(none)'),
}));

// ── Import after mocks ──────────────────────────────────────────────────

import { runContentStrategistAgent } from '../content-strategist-agent.js';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    taskType: 'general_edit',
    clientName: 'Test Client',
    siteId: 'test-site',
    targetPage: 'home',
    applyToAllSites: false,
    needsClarification: false,
    status: 'pending',
    attemptCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function setupMockResponse(planJson: Record<string, unknown>): void {
  mockCreate.mockResolvedValue({
    content: [
      {
        type: 'text',
        text: '```json\n' + JSON.stringify(planJson) + '\n```',
      },
    ],
    usage: { input_tokens: 1000, output_tokens: 500 },
  });
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('Content Strategist Gallery Awareness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes imagePaths in the prompt when task has images', async () => {
    const task = makeTask({
      description: 'Add a portfolio gallery',
      imagePaths: [
        '/path/to/photo1.jpg',
        '/path/to/photo2.jpg',
        '/path/to/photo3.jpg',
      ],
    });

    setupMockResponse({
      summary: 'Add portfolio gallery',
      operations: [],
      sources: [],
      estimatedMinutes: 2,
    });

    await runContentStrategistAgent([task], undefined, undefined);

    // Check that the prompt sent to Claude includes imagePaths
    expect(mockCreate).toHaveBeenCalledOnce();
    const callArgs = mockCreate.mock.calls[0][0];
    const prompt = callArgs.messages[0].content;

    expect(prompt).toContain('Image files provided (3)');
    expect(prompt).toContain('/path/to/photo1.jpg');
    expect(prompt).toContain('/path/to/photo2.jpg');
    expect(prompt).toContain('/path/to/photo3.jpg');
  });

  it('includes gallery documentation in the prompt', async () => {
    const task = makeTask({ description: 'Add photos' });

    setupMockResponse({
      summary: 'Add photos',
      operations: [],
      sources: [],
      estimatedMinutes: 1,
    });

    await runContentStrategistAgent([task], undefined, undefined);

    const prompt = mockCreate.mock.calls[0][0].messages[0].content;

    // Check gallery-specific documentation is in the prompt
    expect(prompt).toContain('Adding Gallery Sections');
    expect(prompt).toContain('galleryStyle');
    expect(prompt).toContain('grid');
    expect(prompt).toContain('slideshow');
    expect(prompt).toContain('collage');
  });

  it('includes image block documentation in the prompt', async () => {
    const task = makeTask({ description: 'Add an image' });

    setupMockResponse({
      summary: 'Add image',
      operations: [],
      sources: [],
      estimatedMinutes: 1,
    });

    await runContentStrategistAgent([task], undefined, undefined);

    const prompt = mockCreate.mock.calls[0][0].messages[0].content;

    expect(prompt).toContain('Adding Image Blocks via API');
    expect(prompt).toContain('type: "image"');
    expect(prompt).toContain('imagePath');
  });

  it('includes gallery example in the output format section', async () => {
    const task = makeTask({ description: 'Create gallery' });

    setupMockResponse({
      summary: 'Create gallery',
      operations: [],
      sources: [],
      estimatedMinutes: 1,
    });

    await runContentStrategistAgent([task], undefined, undefined);

    const prompt = mockCreate.mock.calls[0][0].messages[0].content;

    // Check that gallery examples are included
    expect(prompt).toContain('type: "gallery"');
    expect(prompt).toContain('gallery');
    expect(prompt).toContain('columns');
  });

  it('includes image/gallery routing guidance', async () => {
    const task = makeTask({ description: 'Add images' });

    setupMockResponse({
      summary: 'Add images',
      operations: [],
      sources: [],
      estimatedMinutes: 1,
    });

    await runContentStrategistAgent([task], undefined, undefined);

    const prompt = mockCreate.mock.calls[0][0].messages[0].content;

    expect(prompt).toContain('blank_api with images');
    expect(prompt).toContain('blank_api with gallery');
  });

  it('does not include imagePaths section when task has no images', async () => {
    const task = makeTask({ description: 'Update text on homepage' });

    setupMockResponse({
      summary: 'Update text',
      operations: [],
      sources: [],
      estimatedMinutes: 1,
    });

    await runContentStrategistAgent([task], undefined, undefined);

    const prompt = mockCreate.mock.calls[0][0].messages[0].content;

    expect(prompt).not.toContain('Image files provided');
  });

  it('parses gallery operation from LLM response', async () => {
    const task = makeTask({
      description: 'Add a photo gallery',
      imagePaths: ['/path/to/photo1.jpg', '/path/to/photo2.jpg'],
    });

    setupMockResponse({
      summary: 'Add photo gallery section',
      operations: [
        {
          taskId: 'task-1',
          siteId: 'test-site',
          targetPage: 'home',
          operationType: 'add_section',
          placement: 'Below hero section',
          content: {
            heading: 'Our Gallery',
            contentStrategy: 'blank_api',
            apiBlocks: [
              { html: 'Our Gallery', formatting: { tag: 'h2', alignment: 'center' } },
              {
                type: 'gallery',
                images: [
                  { imagePath: '/path/to/photo1.jpg', altText: 'Photo 1' },
                  { imagePath: '/path/to/photo2.jpg', altText: 'Photo 2' },
                ],
                galleryStyle: 'grid',
                columns: 2,
              },
            ],
          },
          editorInstruction: 'Add blank section with gallery via API.',
        },
      ],
      sources: [],
      estimatedMinutes: 2,
    });

    const result = await runContentStrategistAgent([task], undefined, undefined);

    expect(result.success).toBe(true);
    expect(result.data?.operations).toHaveLength(1);
    expect(result.data?.operations[0].content.contentStrategy).toBe('blank_api');
    expect(result.data?.operations[0].content.apiBlocks).toHaveLength(2);
  });
});
