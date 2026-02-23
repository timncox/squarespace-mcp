import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ContentPlan, ContentOperation, ContentSpec } from '../types.js';
import type { Task } from '../../models/task.js';
import type { Conversation } from '../../models/conversation.js';

// ── Shared test data ─────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-001',
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

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-001',
    source: 'whatsapp',
    status: 'executing',
    taskIds: ['task-001'],
    summaryText: 'Test conversation',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeOperation(overrides: Partial<ContentOperation> = {}): ContentOperation {
  return {
    taskId: 'task-001',
    siteId: 'test-site',
    targetPage: 'home',
    operationType: 'add_section',
    placement: 'Below the hero section',
    content: {
      heading: 'Test Heading',
      bodyText: 'Test body text',
    },
    editorInstruction: 'Use addSectionFromTemplate with category="About"...',
    ...overrides,
  };
}

function makePlan(operationCount: number, overrides: Partial<ContentPlan> = {}): ContentPlan {
  const operations: ContentOperation[] = [];
  for (let i = 0; i < operationCount; i++) {
    operations.push(makeOperation({
      content: {
        heading: `Section ${i + 1}`,
        bodyText: `Body text for section ${i + 1}`,
      },
      editorInstruction: `Step ${i + 1}: Add section ${i + 1}`,
    }));
  }
  return {
    summary: `Add ${operationCount} sections`,
    operations,
    sources: ['https://example.com'],
    estimatedMinutes: operationCount * 2,
    ...overrides,
  };
}

// ── Content Strategy Routing Tests ───────────────────────────────────────────

describe('Content Strategy Routing', () => {
  describe('ContentSpec contentStrategy field', () => {
    it('template strategy includes templateIndex and templateCategory', () => {
      const spec: ContentSpec = {
        heading: 'About Us',
        bodyText: 'Our story...',
        contentStrategy: 'template',
        templateCategory: 'About',
        templateName: 'Bio with Image',
        templateIndex: 0,
      };

      expect(spec.contentStrategy).toBe('template');
      expect(spec.templateIndex).toBe(0);
      expect(spec.templateCategory).toBe('About');
    });

    it('blank_api strategy includes apiBlocks array', () => {
      const spec: ContentSpec = {
        heading: 'Work Experience',
        contentStrategy: 'blank_api',
        apiBlocks: [
          { html: '<h2>Work Experience</h2>' },
          { html: '<h3>Senior Dev — Acme Corp</h3><p>Led frontend...</p>' },
          { html: '<h3>Dev — StartupCo</h3><p>Built React apps...</p>' },
        ],
      };

      expect(spec.contentStrategy).toBe('blank_api');
      expect(spec.apiBlocks).toHaveLength(3);
      expect(spec.apiBlocks![0].html).toContain('Work Experience');
    });

    it('blank_api apiBlocks can include layout hints', () => {
      const spec: ContentSpec = {
        heading: 'Skills',
        contentStrategy: 'blank_api',
        apiBlocks: [
          { html: '<h2>Skills</h2>', layout: { columns: 12 } },
          { html: '<p>JavaScript, TypeScript, React</p>', layout: { columns: 8 } },
        ],
      };

      expect(spec.apiBlocks![0].layout).toEqual({ columns: 12 });
      expect(spec.apiBlocks![1].layout).toEqual({ columns: 8 });
    });

    it('manual strategy has no special fields', () => {
      const spec: ContentSpec = {
        heading: 'Custom Section',
        bodyText: 'Custom content',
        contentStrategy: 'manual',
      };

      expect(spec.contentStrategy).toBe('manual');
      expect(spec.apiBlocks).toBeUndefined();
      expect(spec.templateIndex).toBeUndefined();
    });

    it('operations without contentStrategy default to undefined', () => {
      const op = makeOperation();
      expect(op.content.contentStrategy).toBeUndefined();
    });
  });

  describe('blank_api vs template vs manual separation', () => {
    it('correctly identifies blank_api operations in a mixed plan', () => {
      const plan = makePlan(0, {
        operations: [
          makeOperation({
            content: { heading: 'About', contentStrategy: 'template', templateIndex: 0 },
          }),
          makeOperation({
            content: {
              heading: 'Experience',
              contentStrategy: 'blank_api',
              apiBlocks: [{ html: '<h2>Experience</h2>' }],
            },
          }),
          makeOperation({
            content: { heading: 'Custom', contentStrategy: 'manual' },
          }),
          makeOperation({
            content: {
              heading: 'Education',
              contentStrategy: 'blank_api',
              apiBlocks: [{ html: '<h2>Education</h2>' }],
            },
          }),
        ],
      });

      const blankApiOps = plan.operations.filter(op => op.content.contentStrategy === 'blank_api');
      const templateOps = plan.operations.filter(op => op.content.contentStrategy === 'template');
      const manualOps = plan.operations.filter(op => op.content.contentStrategy === 'manual');

      expect(blankApiOps).toHaveLength(2);
      expect(templateOps).toHaveLength(1);
      expect(manualOps).toHaveLength(1);

      expect(blankApiOps[0].content.heading).toBe('Experience');
      expect(blankApiOps[1].content.heading).toBe('Education');
    });

    it('filters blank_api ops from plan.operations for remaining execution', () => {
      const plan = makePlan(0, {
        operations: [
          makeOperation({ content: { heading: 'About', contentStrategy: 'template' } }),
          makeOperation({ content: { heading: 'CV', contentStrategy: 'blank_api', apiBlocks: [{ html: '<p>CV</p>' }] } }),
          makeOperation({ content: { heading: 'Contact', contentStrategy: 'template' } }),
        ],
      });

      // Simulate what executeTasksWithPlan does: remove blank_api ops after processing
      const remainingOps = plan.operations.filter(op => op.content.contentStrategy !== 'blank_api');

      expect(remainingOps).toHaveLength(2);
      expect(remainingOps[0].content.heading).toBe('About');
      expect(remainingOps[1].content.heading).toBe('Contact');
    });

    it('when all operations are blank_api, remaining plan is empty', () => {
      const plan = makePlan(0, {
        operations: [
          makeOperation({ content: { heading: 'A', contentStrategy: 'blank_api', apiBlocks: [{ html: '<p>A</p>' }] } }),
          makeOperation({ content: { heading: 'B', contentStrategy: 'blank_api', apiBlocks: [{ html: '<p>B</p>' }] } }),
        ],
      });

      const remainingOps = plan.operations.filter(op => op.content.contentStrategy !== 'blank_api');
      expect(remainingOps).toHaveLength(0);
    });
  });
});

// ── Page Creation Ordering Tests ─────────────────────────────────────────────

describe('Page Creation Ordering', () => {
  describe('hasPageCreation flag defers blank_api ops', () => {
    it('defers blank_api when plan includes create_page operationType', () => {
      const plan = makePlan(0, {
        operations: [
          makeOperation({
            operationType: 'create_page' as ContentOperation['operationType'],
            content: { heading: 'New CV Page' },
            editorInstruction: 'Create a new page called "CV"',
          }),
          makeOperation({
            content: {
              heading: 'Experience',
              contentStrategy: 'blank_api',
              apiBlocks: [{ html: '<h2>Experience</h2>' }],
            },
          }),
        ],
      });

      // Replicate the hasPageCreation logic from executeTasksWithPlan
      const hasPageCreation = plan.operations.some(op =>
        op.operationType === 'create_page' || op.targetPage === 'new',
      );

      const blankApiOps = hasPageCreation
        ? [] // defer to browser agent
        : plan.operations.filter(op => op.content.contentStrategy === 'blank_api');

      expect(hasPageCreation).toBe(true);
      expect(blankApiOps).toHaveLength(0);
    });

    it('defers blank_api when targetPage is "new"', () => {
      const plan = makePlan(0, {
        operations: [
          makeOperation({
            targetPage: 'new',
            content: { heading: 'New Page' },
          }),
          makeOperation({
            content: {
              heading: 'Content',
              contentStrategy: 'blank_api',
              apiBlocks: [{ html: '<p>Content</p>' }],
            },
          }),
        ],
      });

      const hasPageCreation = plan.operations.some(op =>
        op.operationType === 'create_page' || op.targetPage === 'new',
      );

      const blankApiOps = hasPageCreation ? [] : plan.operations.filter(op => op.content.contentStrategy === 'blank_api');

      expect(hasPageCreation).toBe(true);
      expect(blankApiOps).toHaveLength(0);
    });

    it('does NOT defer blank_api when no page creation is needed', () => {
      const plan = makePlan(0, {
        operations: [
          makeOperation({
            content: { heading: 'About', contentStrategy: 'template' },
          }),
          makeOperation({
            content: {
              heading: 'Experience',
              contentStrategy: 'blank_api',
              apiBlocks: [{ html: '<h2>Experience</h2>' }],
            },
          }),
        ],
      });

      const hasPageCreation = plan.operations.some(op =>
        op.operationType === 'create_page' || op.targetPage === 'new',
      );

      const blankApiOps = hasPageCreation
        ? []
        : plan.operations.filter(op => op.content.contentStrategy === 'blank_api');

      expect(hasPageCreation).toBe(false);
      expect(blankApiOps).toHaveLength(1);
      expect(blankApiOps[0].content.heading).toBe('Experience');
    });
  });
});

// ── Batching Logic Tests ─────────────────────────────────────────────────────

describe('Batching Logic', () => {
  const BATCH_THRESHOLD = 5;
  const BATCH_SIZE = 3;

  describe('batch threshold detection', () => {
    it('does NOT batch when operations <= BATCH_THRESHOLD', () => {
      const plan = makePlan(5);
      const shouldBatch = plan.operations.length > BATCH_THRESHOLD;
      expect(shouldBatch).toBe(false);
    });

    it('batches when operations > BATCH_THRESHOLD (6 ops)', () => {
      const plan = makePlan(6);
      const shouldBatch = plan.operations.length > BATCH_THRESHOLD;
      expect(shouldBatch).toBe(true);
    });

    it('batches a large plan (8 operations)', () => {
      const plan = makePlan(8);
      const shouldBatch = plan.operations.length > BATCH_THRESHOLD;
      expect(shouldBatch).toBe(true);
    });

    it('does not batch a plan with exactly 5 operations', () => {
      const plan = makePlan(5);
      const shouldBatch = plan.operations.length > BATCH_THRESHOLD;
      expect(shouldBatch).toBe(false);
    });
  });

  describe('chunkOperations', () => {
    // Replicate the chunkOperations logic from execution.ts
    function chunkOperations<T>(operations: T[], batchSize: number): T[][] {
      const chunks: T[][] = [];
      for (let i = 0; i < operations.length; i += batchSize) {
        chunks.push(operations.slice(i, i + batchSize));
      }
      return chunks;
    }

    it('chunks 6 operations into 2 batches of 3', () => {
      const plan = makePlan(6);
      const batches = chunkOperations(plan.operations, BATCH_SIZE);
      expect(batches).toHaveLength(2);
      expect(batches[0]).toHaveLength(3);
      expect(batches[1]).toHaveLength(3);
    });

    it('chunks 8 operations into 3 batches (3, 3, 2)', () => {
      const plan = makePlan(8);
      const batches = chunkOperations(plan.operations, BATCH_SIZE);
      expect(batches).toHaveLength(3);
      expect(batches[0]).toHaveLength(3);
      expect(batches[1]).toHaveLength(3);
      expect(batches[2]).toHaveLength(2);
    });

    it('chunks 1 operation into 1 batch of 1', () => {
      const plan = makePlan(1);
      const batches = chunkOperations(plan.operations, BATCH_SIZE);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(1);
    });

    it('chunks 3 operations into 1 batch of 3', () => {
      const plan = makePlan(3);
      const batches = chunkOperations(plan.operations, BATCH_SIZE);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(3);
    });

    it('preserves operation order within batches', () => {
      const plan = makePlan(6);
      const batches = chunkOperations(plan.operations, BATCH_SIZE);
      expect(batches[0][0].content.heading).toBe('Section 1');
      expect(batches[0][2].content.heading).toBe('Section 3');
      expect(batches[1][0].content.heading).toBe('Section 4');
      expect(batches[1][2].content.heading).toBe('Section 6');
    });
  });
});

// ── Plan Structure & Decomposition Tests ─────────────────────────────────────

describe('Plan Structure and Decomposition', () => {
  describe('ContentPlan structure', () => {
    it('plan has required fields', () => {
      const plan = makePlan(2);
      expect(plan).toHaveProperty('summary');
      expect(plan).toHaveProperty('operations');
      expect(plan).toHaveProperty('sources');
      expect(plan).toHaveProperty('estimatedMinutes');
      expect(Array.isArray(plan.operations)).toBe(true);
      expect(Array.isArray(plan.sources)).toBe(true);
      expect(typeof plan.estimatedMinutes).toBe('number');
    });

    it('each operation has required fields', () => {
      const op = makeOperation();
      expect(op).toHaveProperty('taskId');
      expect(op).toHaveProperty('siteId');
      expect(op).toHaveProperty('targetPage');
      expect(op).toHaveProperty('operationType');
      expect(op).toHaveProperty('placement');
      expect(op).toHaveProperty('content');
      expect(op).toHaveProperty('editorInstruction');
    });
  });

  describe('instruction map building (single task)', () => {
    it('combines all plan operations into one instruction for a single-task conversation', () => {
      const conversation = makeConversation({ taskIds: ['task-001'] });
      const plan = makePlan(3);

      // Replicate the single-task instruction map logic from executeTasksWithPlan
      const instructionMap = new Map<string, string>();

      if (conversation.taskIds.length === 1) {
        const stepLines = plan.operations
          .map((op, i) => {
            const typeLabel = op.operationType?.replace(/_/g, ' ') ?? 'action';
            return `## Step ${i + 1} — ${typeLabel}\n${op.editorInstruction}`;
          })
          .join('\n\n');

        const combinedInstruction = `You are executing a content plan with ${plan.operations.length} steps.\n` +
          `Complete each step IN ORDER.\n\n` +
          stepLines;

        instructionMap.set(conversation.taskIds[0], combinedInstruction);
      }

      expect(instructionMap.size).toBe(1);
      const instruction = instructionMap.get('task-001')!;
      expect(instruction).toContain('3 steps');
      expect(instruction).toContain('## Step 1');
      expect(instruction).toContain('## Step 2');
      expect(instruction).toContain('## Step 3');
    });
  });

  describe('instruction map building (multi-task)', () => {
    it('groups operations by siteId+targetPage for multi-task conversations', () => {
      const conversation = makeConversation({ taskIds: ['task-001', 'task-002'] });
      const plan = makePlan(0, {
        operations: [
          makeOperation({ siteId: 'site-a', targetPage: 'home', editorInstruction: 'Edit home' }),
          makeOperation({ siteId: 'site-b', targetPage: 'about', editorInstruction: 'Edit about' }),
          makeOperation({ siteId: 'site-a', targetPage: 'home', editorInstruction: 'Another home edit' }),
        ],
      });

      // We need mock task lookups for multi-task mode.
      // In the real code, getTask is called. Here we simulate the mapping logic.
      const tasks: Task[] = [
        makeTask({ id: 'task-001', siteId: 'site-a', targetPage: 'home' }),
        makeTask({ id: 'task-002', siteId: 'site-b', targetPage: 'about' }),
      ];

      const tasksByKey = new Map<string, string>();
      for (const task of tasks) {
        const key = `${task.siteId}|${task.targetPage ?? ''}`;
        tasksByKey.set(key, task.id);
      }

      const opsPerTask = new Map<string, ContentOperation[]>();
      for (const op of plan.operations) {
        const key = `${op.siteId}|${op.targetPage ?? ''}`;
        const realTaskId = tasksByKey.get(key) ?? conversation.taskIds[0];
        const existing = opsPerTask.get(realTaskId) || [];
        existing.push(op);
        opsPerTask.set(realTaskId, existing);
      }

      expect(opsPerTask.get('task-001')).toHaveLength(2);
      expect(opsPerTask.get('task-002')).toHaveLength(1);
    });
  });

  describe('mixed strategy plan decomposition', () => {
    it('correctly decomposes a plan with all three strategies', () => {
      const plan = makePlan(0, {
        operations: [
          makeOperation({
            content: {
              heading: 'About Section',
              contentStrategy: 'template',
              templateCategory: 'About',
              templateIndex: 0,
            },
          }),
          makeOperation({
            content: {
              heading: 'CV Content',
              contentStrategy: 'blank_api',
              apiBlocks: [
                { html: '<h2>Experience</h2>' },
                { html: '<p>Details...</p>' },
              ],
            },
          }),
          makeOperation({
            content: {
              heading: 'Interactive Widget',
              contentStrategy: 'manual',
              blockType: 'embed',
            },
          }),
        ],
      });

      // Verify we can separate by strategy
      const byStrategy = {
        template: plan.operations.filter(op => op.content.contentStrategy === 'template'),
        blank_api: plan.operations.filter(op => op.content.contentStrategy === 'blank_api'),
        manual: plan.operations.filter(op => op.content.contentStrategy === 'manual'),
      };

      expect(byStrategy.template).toHaveLength(1);
      expect(byStrategy.blank_api).toHaveLength(1);
      expect(byStrategy.manual).toHaveLength(1);

      // Verify blank_api has apiBlocks
      expect(byStrategy.blank_api[0].content.apiBlocks).toHaveLength(2);

      // Verify template has templateIndex
      expect(byStrategy.template[0].content.templateIndex).toBe(0);

      // After removing blank_api ops, template and manual remain
      const remaining = plan.operations.filter(op => op.content.contentStrategy !== 'blank_api');
      expect(remaining).toHaveLength(2);
      expect(remaining.map(op => op.content.contentStrategy)).toEqual(['template', 'manual']);
    });
  });
});

// ── Planning Trigger Detection Tests ─────────────────────────────────────────

describe('Planning Trigger Detection', () => {
  // Replicate taskNeedsContentPlanning logic inline for unit testing (pure function)
  function taskNeedsContentPlanning(task: Task, originalMessage?: string): boolean {
    if (task.taskType === 'remove_content') return false;
    if (task.taskType === 'replace_file') return false;
    if (task.taskType === 'upload_file_and_link') return false;
    if (task.contentToAdd && task.contentToAdd.length > 20) return false;
    if (task.description && task.description.includes('--- PDF Content from')) return false;
    if (task.taskType === 'add_content' && !task.contentToAdd) return true;
    const creativePatterns = [
      'add something', 'put something', 'create a', 'promote', 'promotion',
      'announce', 'announcement', 'advertise', 'highlight', 'feature',
      'showcase', 'add a section', 'add a new section', 'add a blank section',
      'add content', 'write', 'draft', 'come up with', 'suggest', 'recommend',
      'restaurant week', 'special event', 'holiday', 'seasonal',
      'new section about', 'new section for', 'add info about',
      'add information about', 'endorsement', 'testimonial', 'reference',
      'quote block',
    ];
    if (task.description) {
      const desc = task.description.toLowerCase();
      if (creativePatterns.some((p) => desc.includes(p))) return true;
    }
    if (originalMessage) {
      const orig = originalMessage.toLowerCase();
      if (creativePatterns.some((p) => orig.includes(p))) return true;
    }
    return false;
  }

  it('triggers planning for "add a section"', () => {
    const task = makeTask({ description: 'add a section about our team' });
    expect(taskNeedsContentPlanning(task)).toBe(true);
  });

  it('triggers planning for "add a new section"', () => {
    const task = makeTask({ description: 'add a new section for testimonials' });
    expect(taskNeedsContentPlanning(task)).toBe(true);
  });

  it('triggers planning for "testimonial"', () => {
    const task = makeTask({ description: 'Add client testimonials to the homepage' });
    expect(taskNeedsContentPlanning(task)).toBe(true);
  });

  it('does NOT trigger planning for remove_content', () => {
    const task = makeTask({ taskType: 'remove_content', description: 'remove the announcement' });
    expect(taskNeedsContentPlanning(task)).toBe(false);
  });

  it('does NOT trigger planning when contentToAdd is provided (>20 chars)', () => {
    const task = makeTask({
      description: 'add a section',
      contentToAdd: 'This is the exact content to add to the website verbatim.',
    });
    expect(taskNeedsContentPlanning(task)).toBe(false);
  });

  it('does NOT trigger planning for PDF content', () => {
    const task = makeTask({
      description: '--- PDF Content from menu.pdf ---\nPasta $12\nSalad $8',
    });
    expect(taskNeedsContentPlanning(task)).toBe(false);
  });

  it('triggers planning for add_content with no contentToAdd', () => {
    const task = makeTask({ taskType: 'add_content', contentToAdd: undefined });
    expect(taskNeedsContentPlanning(task)).toBe(true);
  });

  it('triggers planning for creative keywords: "promote", "announce", "showcase"', () => {
    expect(taskNeedsContentPlanning(makeTask({ description: 'promote our new menu' }))).toBe(true);
    expect(taskNeedsContentPlanning(makeTask({ description: 'announce restaurant week' }))).toBe(true);
    expect(taskNeedsContentPlanning(makeTask({ description: 'showcase our team members' }))).toBe(true);
  });

  it('does NOT trigger planning for simple edit descriptions', () => {
    const task = makeTask({ description: 'change the phone number to 555-1234' });
    expect(taskNeedsContentPlanning(task)).toBe(false);
  });

  // ── originalMessage parameter tests ───────────────────────────────────────

  it('triggers planning when originalMessage contains "suggest" but description does not', () => {
    // The request interpreter strips "suggest" from the description
    const task = makeTask({ description: 'Update the homepage with new content about our services' });
    expect(taskNeedsContentPlanning(task)).toBe(false); // would miss without originalMessage
    expect(taskNeedsContentPlanning(task, 'Can you suggest some content for the homepage about our services?')).toBe(true);
  });

  it('triggers planning when originalMessage contains "come up with" but description does not', () => {
    const task = makeTask({ description: 'Add team member bios to the about page' });
    expect(taskNeedsContentPlanning(task)).toBe(false);
    expect(taskNeedsContentPlanning(task, 'Come up with some team bios for the about page')).toBe(true);
  });

  it('triggers planning when originalMessage contains "recommend" but description does not', () => {
    const task = makeTask({ description: 'Add a section to the homepage' });
    // "add a section" already triggers, so test with a stripped description
    const task2 = makeTask({ description: 'Update the contact page with better layout' });
    expect(taskNeedsContentPlanning(task2)).toBe(false);
    expect(taskNeedsContentPlanning(task2, 'Can you recommend a better layout for the contact page?')).toBe(true);
  });

  it('still triggers from description even when no originalMessage is provided', () => {
    const task = makeTask({ description: 'add a section about our team' });
    expect(taskNeedsContentPlanning(task)).toBe(true);
    expect(taskNeedsContentPlanning(task, undefined)).toBe(true);
  });

  it('does NOT trigger when neither description nor originalMessage have creative keywords', () => {
    const task = makeTask({ description: 'change phone number to 555-0000' });
    expect(taskNeedsContentPlanning(task, 'Please change the phone number to 555-0000')).toBe(false);
  });

  it('respects early-exit rules even when originalMessage has creative keywords', () => {
    // remove_content tasks should never trigger planning, even with creative originalMessage
    const task = makeTask({ taskType: 'remove_content', description: 'remove the old banner' });
    expect(taskNeedsContentPlanning(task, 'Can you suggest removing the old banner?')).toBe(false);
  });
});

// ── Step Budget Estimation Tests ─────────────────────────────────────────────

describe('Step Budget Estimation', () => {
  // Replicate the estimateStepBudget logic from execution.ts
  function estimateStepBudget(task: Task, isPageCreation: boolean, taskDescription: string): number {
    if (isPageCreation) return 50;
    const desc = taskDescription.toLowerCase();
    const multiEditKeywords = [
      'and then', 'also', 'additionally', 'as well',
      'step 1', 'step 2', 'step 3',
      'first,', 'second,', 'third,',
      'update all', 'change all', 'replace all',
      'each project', 'each section', 'every',
    ];
    const complexityHits = multiEditKeywords.filter((kw) => desc.includes(kw)).length;
    const simpleTypes: Set<string> = new Set(['remove_content']);
    const mediumTypes: Set<string> = new Set(['replace_file', 'upload_file_and_link']);
    const complexTypes: Set<string> = new Set(['add_content', 'update_menu_block']);

    let base: number;
    if (simpleTypes.has(task.taskType)) {
      base = 25;
    } else if (mediumTypes.has(task.taskType)) {
      base = 35;
    } else if (complexTypes.has(task.taskType)) {
      base = 50;
    } else {
      if (desc.length < 150 && complexityHits === 0) {
        base = 25;
      } else if (desc.length < 400 && complexityHits <= 1) {
        base = 35;
      } else {
        base = 50;
      }
    }
    const boost = Math.min(30, complexityHits * 5);
    return Math.min(80, Math.max(20, base + boost));
  }

  it('returns 50 for page creation tasks', () => {
    const task = makeTask();
    expect(estimateStepBudget(task, true, 'create a new page')).toBe(50);
  });

  it('returns 25 for simple remove_content tasks', () => {
    const task = makeTask({ taskType: 'remove_content' });
    expect(estimateStepBudget(task, false, 'remove the old banner')).toBe(25);
  });

  it('returns 35 for medium replace_file tasks', () => {
    const task = makeTask({ taskType: 'replace_file' });
    expect(estimateStepBudget(task, false, 'replace the menu PDF')).toBe(35);
  });

  it('returns 50 for complex add_content tasks', () => {
    const task = makeTask({ taskType: 'add_content' });
    expect(estimateStepBudget(task, false, 'add a new services section')).toBe(50);
  });

  it('boosts budget for multi-step descriptions', () => {
    const task = makeTask();
    const desc = 'First, update the heading. Also change the image. Additionally, fix the button.';
    const budget = estimateStepBudget(task, false, desc);
    // 3 complexity keywords × 5 = 15 boost, base would be 35 (< 400 chars, 1 complexity keyword at "also")
    // Actually "first," "also" "additionally" = 3 hits, base = 50 (>1 hit), boost = 15 → 65
    expect(budget).toBeGreaterThan(50);
    expect(budget).toBeLessThanOrEqual(80);
  });

  it('caps budget at 80 regardless of complexity', () => {
    const task = makeTask();
    // Cram in as many complexity keywords as possible
    const desc = 'step 1: update all headings. step 2: change all images. step 3: replace all buttons. ' +
      'first, do this. second, do that. third, fix it. and then save. also verify. additionally check. ' +
      'each project and each section and every page.';
    const budget = estimateStepBudget(task, false, desc);
    expect(budget).toBeLessThanOrEqual(80);
  });

  it('returns 25 for short simple general_edit descriptions', () => {
    const task = makeTask({ taskType: 'general_edit' });
    expect(estimateStepBudget(task, false, 'change phone number')).toBe(25);
  });

  describe('retry multiplier', () => {
    it('applies 1.5x multiplier on attempt 2', () => {
      const baseBudget = 50;
      const attemptCount = 1;
      const retryMultiplier = 1 + (attemptCount * 0.5);
      const maxSteps = Math.min(120, Math.round(baseBudget * retryMultiplier));
      expect(retryMultiplier).toBe(1.5);
      expect(maxSteps).toBe(75);
    });

    it('applies 2x multiplier on attempt 3', () => {
      const baseBudget = 50;
      const attemptCount = 2;
      const retryMultiplier = 1 + (attemptCount * 0.5);
      const maxSteps = Math.min(120, Math.round(baseBudget * retryMultiplier));
      expect(retryMultiplier).toBe(2);
      expect(maxSteps).toBe(100);
    });

    it('caps at 120 even with high multiplier and high base', () => {
      const baseBudget = 80;
      const attemptCount = 2;
      const retryMultiplier = 1 + (attemptCount * 0.5);
      const maxSteps = Math.min(120, Math.round(baseBudget * retryMultiplier));
      expect(maxSteps).toBe(120);
    });
  });
});

// ── Batch Instruction Builder Tests ──────────────────────────────────────────

describe('Batch Instruction Builder', () => {
  // Replicate buildBatchInstruction from execution.ts
  function buildBatchInstruction(
    batch: ContentOperation[],
    batchNum: number,
    totalBatches: number,
    planSummary: string,
  ): string {
    const stepLines = batch
      .map((op, i) => {
        const typeLabel = op.operationType?.replace(/_/g, ' ') ?? 'action';
        return `## Step ${i + 1} — ${typeLabel}\n${op.editorInstruction}`;
      })
      .join('\n\n');

    return (
      `You are executing batch ${batchNum} of ${totalBatches} for: "${planSummary}"\n` +
      `Complete these ${batch.length} steps IN ORDER, then STOP.\n\n` +
      `## ACTION GUIDE (which click action to use)\n` +
      `- **Admin UI** (ADD SECTION, + Add Blank, Edit Section, ADD BLOCK, block picker, Save, Done, toolbars, panels): use **click** (main frame)\n` +
      `- **Page content** (text blocks, images, buttons, sections rendered on the page): use **clickInIframe** or **dblclickInIframe**\n` +
      `- If click fails on an admin button, try **jsClick** with frame: "main"\n\n` +
      stepLines +
      `\n\nIMPORTANT: After completing these ${batch.length} steps, STOP. Do not attempt additional operations. ` +
      `Scroll down slightly so the next batch can continue adding content below.`
    );
  }

  it('produces instruction with correct batch numbers', () => {
    const batch = [makeOperation()];
    const instruction = buildBatchInstruction(batch, 2, 5, 'Add 15 sections');
    expect(instruction).toContain('batch 2 of 5');
    expect(instruction).toContain('Add 15 sections');
  });

  it('includes all step instructions from batch operations', () => {
    const batch = [
      makeOperation({ editorInstruction: 'Add the about section' }),
      makeOperation({ editorInstruction: 'Add the contact section' }),
    ];
    const instruction = buildBatchInstruction(batch, 1, 3, 'Plan summary');
    expect(instruction).toContain('## Step 1');
    expect(instruction).toContain('Add the about section');
    expect(instruction).toContain('## Step 2');
    expect(instruction).toContain('Add the contact section');
  });

  it('includes STOP instruction to prevent over-execution', () => {
    const batch = [makeOperation()];
    const instruction = buildBatchInstruction(batch, 1, 3, 'Summary');
    expect(instruction).toContain('STOP');
    expect(instruction).toContain('Do not attempt additional operations');
  });

  it('includes action guide for click disambiguation', () => {
    const batch = [makeOperation()];
    const instruction = buildBatchInstruction(batch, 1, 1, 'Summary');
    expect(instruction).toContain('ACTION GUIDE');
    expect(instruction).toContain('clickInIframe');
    expect(instruction).toContain('jsClick');
  });
});

// ── Page Creation Detection Tests ────────────────────────────────────────────

describe('Page Creation Detection', () => {
  // Replicate taskIsPageCreation from planning.ts
  function taskIsPageCreation(task: Task): boolean {
    const desc = (task.description ?? '').toLowerCase();
    const pageCreationPatterns = [
      'create a new page', 'create a page', 'add a new page', 'add a page',
      'new page called', 'new page named', 'new page for', 'new page to',
      'create page', 'add page',
    ];
    return pageCreationPatterns.some((p) => desc.includes(p));
  }

  it('detects "create a new page" tasks', () => {
    expect(taskIsPageCreation(makeTask({ description: 'create a new page called CV' }))).toBe(true);
  });

  it('detects "add a page" tasks', () => {
    expect(taskIsPageCreation(makeTask({ description: 'add a page for testimonials' }))).toBe(true);
  });

  it('does NOT detect regular editing tasks', () => {
    expect(taskIsPageCreation(makeTask({ description: 'update the homepage hero image' }))).toBe(false);
  });

  it('does NOT detect "add a section" as page creation', () => {
    expect(taskIsPageCreation(makeTask({ description: 'add a section about our team' }))).toBe(false);
  });
});

// ── ContentPlan Operation Types Tests ────────────────────────────────────────

describe('ContentPlan Operation Types', () => {
  it('supports all defined operationType values', () => {
    const types: ContentOperation['operationType'][] = [
      'add_section', 'add_block', 'modify_text',
      'replace_image', 'remove_block', 'modify_block', 'modify_style',
    ];

    for (const type of types) {
      const op = makeOperation({ operationType: type });
      expect(op.operationType).toBe(type);
    }
  });

  it('operations preserve taskId across all operations in a plan', () => {
    const plan = makePlan(4);
    for (const op of plan.operations) {
      expect(op.taskId).toBe('task-001');
    }
  });

  it('operations can target different pages', () => {
    const plan = makePlan(0, {
      operations: [
        makeOperation({ targetPage: 'home' }),
        makeOperation({ targetPage: 'about' }),
        makeOperation({ targetPage: 'contact' }),
      ],
    });

    const pages = plan.operations.map(op => op.targetPage);
    expect(pages).toEqual(['home', 'about', 'contact']);
  });
});
