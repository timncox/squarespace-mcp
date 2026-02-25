import { describe, it, expect } from 'vitest';
import { taskNeedsContentPlanning, taskIsPageCreation, formatContentPlanForTim } from '../planning.js';
import type { Task } from '../../../models/task.js';
import type { ContentPlan, ContentOperation, ContentSpec } from '../../../agents/types.js';

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

function makeOperation(overrides: Partial<ContentOperation> = {}): ContentOperation {
  return {
    taskId: 'task-1',
    siteId: 'test-site',
    targetPage: 'home',
    operationType: 'add_section',
    placement: 'below hero',
    content: { heading: 'Test Heading', bodyText: 'Test body' },
    editorInstruction: 'Add a new section below the hero',
    ...overrides,
  };
}

function makePlan(overrides: Partial<ContentPlan> = {}): ContentPlan {
  return {
    summary: 'Add a team section to the homepage',
    operations: [makeOperation()],
    sources: [],
    estimatedMinutes: 5,
    ...overrides,
  };
}

// ─── taskNeedsContentPlanning ────────────────────────────────────────────────

describe('taskNeedsContentPlanning', () => {
  // ── Task types that never need planning ──────────────────────────────────

  it('returns false for remove_content task type', () => {
    const task = makeTask({ taskType: 'remove_content', description: 'remove the about section' });
    expect(taskNeedsContentPlanning(task)).toBe(false);
  });

  it('returns false for replace_file task type', () => {
    const task = makeTask({ taskType: 'replace_file', description: 'replace the menu PDF' });
    expect(taskNeedsContentPlanning(task)).toBe(false);
  });

  it('returns false for upload_file_and_link task type', () => {
    const task = makeTask({ taskType: 'upload_file_and_link', description: 'upload new brochure' });
    expect(taskNeedsContentPlanning(task)).toBe(false);
  });

  // ── Content already provided ─────────────────────────────────────────────

  it('returns false when contentToAdd has >20 characters', () => {
    const task = makeTask({
      taskType: 'add_content',
      contentToAdd: 'Here is the exact text to add to the page, no creativity needed.',
    });
    expect(taskNeedsContentPlanning(task)).toBe(false);
  });

  it('returns true when contentToAdd is short (<=20 chars) and description matches', () => {
    const task = makeTask({
      taskType: 'general_edit',
      contentToAdd: 'placeholder',
      description: 'add a section about our team',
    });
    expect(taskNeedsContentPlanning(task)).toBe(true);
  });

  // ── PDF content ──────────────────────────────────────────────────────────

  it('returns false for PDF content (already extracted inline)', () => {
    const task = makeTask({
      taskType: 'add_content',
      description: 'Add this to the page --- PDF Content from menu.pdf --- Full text here...',
    });
    expect(taskNeedsContentPlanning(task)).toBe(false);
  });

  // ── add_content without content ──────────────────────────────────────────

  it('returns true for add_content without contentToAdd', () => {
    const task = makeTask({
      taskType: 'add_content',
      contentToAdd: undefined,
      description: 'add new content',
    });
    expect(taskNeedsContentPlanning(task)).toBe(true);
  });

  it('returns true for add_content with empty string contentToAdd', () => {
    // empty string is falsy
    const task = makeTask({
      taskType: 'add_content',
      contentToAdd: '',
      description: 'add content to the page',
    });
    expect(taskNeedsContentPlanning(task)).toBe(true);
  });

  // ── Creative pattern matching (description) ──────────────────────────────

  describe('creative pattern matching in description', () => {
    const creativeDescriptions = [
      ['suggest', 'suggest some content for the homepage'],
      ['come up with', 'come up with text for the about page'],
      ['write', 'write content for the services page'],
      ['draft', 'draft a welcome message'],
      ['create a', 'create a testimonials section'],
      ['promote', 'promote the new summer menu'],
      ['promotion', 'add a promotion for restaurant week'],
      ['announce', 'announce the new chef'],
      ['announcement', 'add an announcement about the holiday hours'],
      ['advertise', 'advertise the happy hour special'],
      ['highlight', 'highlight our signature dishes'],
      ['feature', 'feature our team members'],
      ['showcase', 'showcase the renovations'],
      ['add something', 'add something about our story'],
      ['put something', 'put something on the homepage about catering'],
      ['add content', 'add content about our services'],
      ['add a section', 'add a section about our team'],
      ['add a new section', 'add a new section for testimonials'],
      ['add a blank section', 'add a blank section for custom content'],
      ['new section about', 'new section about the menu'],
      ['new section for', 'new section for upcoming events'],
      ['add info about', 'add info about parking and directions'],
      ['add information about', 'add information about our catering services'],
      ['restaurant week', 'update the site for restaurant week'],
      ['special event', 'add a special event banner'],
      ['holiday', 'add holiday hours information'],
      ['seasonal', 'add seasonal menu updates'],
      ['endorsement', 'add an endorsement from a local critic'],
      ['testimonial', 'add a testimonial section'],
      ['reference', 'add a reference to the award'],
      ['quote block', 'add a quote block from the owner'],
      ['recommend', 'recommend what to add to the about page'],
    ];

    for (const [pattern, description] of creativeDescriptions) {
      it(`matches creative pattern: "${pattern}"`, () => {
        const task = makeTask({ description });
        expect(taskNeedsContentPlanning(task)).toBe(true);
      });
    }
  });

  // ── REGRESSION: "add a new section" must match ───────────────────────────

  it('REGRESSION: "add a new section" matches (was broken by "add a section" substring)', () => {
    const task = makeTask({ description: 'add a new section to the homepage with team bios' });
    expect(taskNeedsContentPlanning(task)).toBe(true);
  });

  it('REGRESSION: "Add a new section about our services" matches (case-insensitive)', () => {
    const task = makeTask({ description: 'Add a new section about our services' });
    expect(taskNeedsContentPlanning(task)).toBe(true);
  });

  // ── Original message fallback (request interpreter strips keywords) ──────

  describe('originalMessage fallback', () => {
    it('matches when originalMessage has "suggest" but description was rewritten', () => {
      const task = makeTask({
        description: 'Update the about page with new team information',
      });
      expect(taskNeedsContentPlanning(task)).toBe(false); // description alone doesn't match
      expect(taskNeedsContentPlanning(task, 'Can you suggest some content for the about page?')).toBe(true);
    });

    it('matches when originalMessage has "come up with" but description was rewritten', () => {
      const task = makeTask({
        description: 'Add team bios to the about page',
      });
      expect(taskNeedsContentPlanning(task, 'Come up with some team bios for the about page')).toBe(true);
    });

    it('matches when originalMessage has "recommend" but description was rewritten', () => {
      const task = makeTask({
        description: 'Update homepage content',
      });
      expect(taskNeedsContentPlanning(task, 'Can you recommend what to put on the homepage?')).toBe(true);
    });

    it('does not match if neither description nor originalMessage has patterns', () => {
      const task = makeTask({
        description: 'Change the phone number to 555-1234',
      });
      expect(taskNeedsContentPlanning(task, 'Please change the phone number to 555-1234')).toBe(false);
    });
  });

  // ── Cases that should NOT trigger planning ───────────────────────────────

  describe('non-planning tasks', () => {
    it('returns false for simple text update', () => {
      const task = makeTask({ description: 'update the text on homepage to say Welcome' });
      expect(taskNeedsContentPlanning(task)).toBe(false);
    });

    it('returns false for changing a phone number', () => {
      const task = makeTask({ description: 'change the phone number to 555-0123' });
      expect(taskNeedsContentPlanning(task)).toBe(false);
    });

    it('returns false for removing a section (general_edit, no creative keywords)', () => {
      const task = makeTask({ description: 'remove the team section from the about page' });
      expect(taskNeedsContentPlanning(task)).toBe(false);
    });

    it('returns true for "remove the testimonials section" (matches "testimonial" creative pattern)', () => {
      // "testimonial" is a creative keyword — this is a known quirk: even removal
      // descriptions containing creative keywords trigger planning. In practice,
      // removal tasks use taskType: 'remove_content' which short-circuits first.
      const task = makeTask({ description: 'remove the testimonials section' });
      expect(taskNeedsContentPlanning(task)).toBe(true);
    });

    it('returns false for updating business hours', () => {
      const task = makeTask({ description: 'update hours to Mon-Fri 9-5' });
      expect(taskNeedsContentPlanning(task)).toBe(false);
    });

    it('returns false for empty description with no matching task type', () => {
      const task = makeTask({ description: '' });
      expect(taskNeedsContentPlanning(task)).toBe(false);
    });

    it('returns false for undefined description with no matching task type', () => {
      const task = makeTask({ description: undefined });
      expect(taskNeedsContentPlanning(task)).toBe(false);
    });
  });

  // ── Case insensitivity ───────────────────────────────────────────────────

  it('pattern matching is case-insensitive', () => {
    const task = makeTask({ description: 'SHOWCASE our new menu items' });
    expect(taskNeedsContentPlanning(task)).toBe(true);
  });

  it('pattern matching is case-insensitive for originalMessage', () => {
    const task = makeTask({ description: 'update the about page' });
    expect(taskNeedsContentPlanning(task, 'SUGGEST some content')).toBe(true);
  });
});

// ─── taskIsPageCreation ──────────────────────────────────────────────────────

describe('taskIsPageCreation', () => {
  // ── Matching patterns ────────────────────────────────────────────────────

  const pageCreationDescriptions = [
    ['create a new page', 'create a new page for our services'],
    ['create a page', 'create a page for catering'],
    ['add a new page', 'add a new page called Team'],
    ['add a page', 'add a page for upcoming events'],
    ['new page called', 'I need a new page called Menu'],
    ['new page named', 'new page named Contact Us'],
    ['new page for', 'set up a new page for the blog'],
    ['new page to', 'I want a new page to show our work'],
    ['create page', 'create page for reservations'],
    ['add page', 'add page for gallery'],
  ];

  for (const [pattern, description] of pageCreationDescriptions) {
    it(`matches: "${pattern}"`, () => {
      const task = makeTask({ description });
      expect(taskIsPageCreation(task)).toBe(true);
    });
  }

  // ── Non-matching ─────────────────────────────────────────────────────────

  it('returns false for "edit the page"', () => {
    const task = makeTask({ description: 'edit the page header' });
    expect(taskIsPageCreation(task)).toBe(false);
  });

  it('returns false for empty description', () => {
    const task = makeTask({ description: '' });
    expect(taskIsPageCreation(task)).toBe(false);
  });

  it('returns false for undefined description', () => {
    const task = makeTask({ description: undefined });
    expect(taskIsPageCreation(task)).toBe(false);
  });

  it('returns false for "update the about page"', () => {
    const task = makeTask({ description: 'update the about page' });
    expect(taskIsPageCreation(task)).toBe(false);
  });

  it('returns false for "switch page to services"', () => {
    const task = makeTask({ description: 'switch page to services' });
    expect(taskIsPageCreation(task)).toBe(false);
  });

  it('returns false for "delete the page"', () => {
    const task = makeTask({ description: 'delete the page' });
    expect(taskIsPageCreation(task)).toBe(false);
  });

  // ── Case insensitivity ───────────────────────────────────────────────────

  it('matching is case-insensitive', () => {
    const task = makeTask({ description: 'CREATE A NEW PAGE for Gallery' });
    expect(taskIsPageCreation(task)).toBe(true);
  });
});

// ─── formatContentPlanForTim ─────────────────────────────────────────────────

describe('formatContentPlanForTim', () => {
  it('includes plan summary', () => {
    const plan = makePlan({ summary: 'Add team bios and a contact form' });
    const result = formatContentPlanForTim(plan);
    expect(result).toContain('Add team bios and a contact form');
  });

  it('includes header with Content Plan title', () => {
    const result = formatContentPlanForTim(makePlan());
    expect(result).toContain('Content Plan');
  });

  it('formats operations with numbering', () => {
    const plan = makePlan({
      operations: [
        makeOperation({ operationType: 'add_section', content: { heading: 'Our Team' } }),
        makeOperation({ operationType: 'add_section', content: { heading: 'Contact Us' } }),
      ],
    });
    const result = formatContentPlanForTim(plan);
    expect(result).toContain('1. *Add section*: "Our Team"');
    expect(result).toContain('2. *Add section*: "Contact Us"');
  });

  it('includes button info when present', () => {
    const plan = makePlan({
      operations: [
        makeOperation({
          content: { heading: 'Get Started', button: { label: 'Book Now', url: '/booking' } },
        }),
      ],
    });
    const result = formatContentPlanForTim(plan);
    expect(result).toContain('Book Now');
  });

  it('handles empty operations array', () => {
    const plan = makePlan({ operations: [] });
    const result = formatContentPlanForTim(plan);
    // Should still include header, summary, footer
    expect(result).toContain('Content Plan');
    expect(result).toContain(plan.summary);
    expect(result).toContain('Estimated');
  });

  it('includes estimated minutes', () => {
    const plan = makePlan({ estimatedMinutes: 15 });
    const result = formatContentPlanForTim(plan);
    expect(result).toContain('~15 min');
  });

  it('includes sources when present', () => {
    const plan = makePlan({ sources: ['https://example.com/about', 'https://yelp.com/biz/test'] });
    const result = formatContentPlanForTim(plan);
    expect(result).toContain('Sources:');
    expect(result).toContain('https://example.com/about');
    expect(result).toContain('https://yelp.com/biz/test');
  });

  it('limits sources to 3', () => {
    const plan = makePlan({
      sources: ['https://a.com', 'https://b.com', 'https://c.com', 'https://d.com'],
    });
    const result = formatContentPlanForTim(plan);
    expect(result).toContain('https://a.com');
    expect(result).toContain('https://b.com');
    expect(result).toContain('https://c.com');
    expect(result).not.toContain('https://d.com');
  });

  it('omits sources section when empty', () => {
    const plan = makePlan({ sources: [] });
    const result = formatContentPlanForTim(plan);
    expect(result).not.toContain('Sources:');
  });

  it('includes approval prompt footer', () => {
    const result = formatContentPlanForTim(makePlan());
    expect(result).toContain('Approve, or tell me what to change.');
  });

  // ── Operation type labels ──────────────────────────────────────────────

  describe('operation type labels', () => {
    const labelCases: Array<[ContentOperation['operationType'], string]> = [
      ['add_section', 'Add section'],
      ['modify_text', 'modify text'],
      ['replace_image', 'replace image'],
      ['remove_block', 'remove block'],
      ['create_page', 'Create new page'],
      ['add_block', 'add block'],
      ['modify_style', 'modify style'],
    ];

    for (const [opType, expectedLabel] of labelCases) {
      it(`shows correct label for ${opType}`, () => {
        const plan = makePlan({
          operations: [makeOperation({ operationType: opType, content: { heading: 'Test' } })],
        });
        const result = formatContentPlanForTim(plan);
        expect(result).toContain(`*${expectedLabel}*`);
      });
    }
  });

  // ── Large plan (>6 operations) ───────────────────────────────────────────

  it('shows count and first 4 examples for large plans (>6 ops)', () => {
    const ops = Array.from({ length: 8 }, (_, i) =>
      makeOperation({
        content: { heading: `Section ${i + 1}` },
      }),
    );
    const plan = makePlan({ operations: ops });
    const result = formatContentPlanForTim(plan);
    expect(result).toContain('*8 steps total:*');
    expect(result).toContain('Section 1');
    expect(result).toContain('Section 4');
    expect(result).toContain('... and 4 more');
    // Should NOT show items 5-8 individually
    expect(result).not.toContain('5. *Add section*');
  });

  it('shows all operations individually for <=6 ops', () => {
    const ops = Array.from({ length: 6 }, (_, i) =>
      makeOperation({
        content: { heading: `Section ${i + 1}` },
      }),
    );
    const plan = makePlan({ operations: ops });
    const result = formatContentPlanForTim(plan);
    expect(result).toContain('1. *Add section*');
    expect(result).toContain('6. *Add section*');
    expect(result).not.toContain('steps total');
  });

  // ── WhatsApp length limit ────────────────────────────────────────────────

  it('truncates messages exceeding 3900 chars', () => {
    const longSummary = 'A'.repeat(4000);
    const plan = makePlan({ summary: longSummary });
    const result = formatContentPlanForTim(plan);
    expect(result.length).toBeLessThanOrEqual(3900 + 50); // truncation + suffix
    expect(result).toContain('_(plan truncated)_');
  });

  // ── Different contentStrategy types in operations ────────────────────────

  it('handles operations with different contentStrategy types', () => {
    const plan = makePlan({
      operations: [
        makeOperation({
          content: { heading: 'Team', contentStrategy: 'template', templateCategory: 'Team' },
        }),
        makeOperation({
          content: { heading: 'CV', contentStrategy: 'blank_api', apiBlocks: [{ html: '<p>Bio</p>' }] },
        }),
        makeOperation({
          content: { heading: 'Custom', contentStrategy: 'manual' },
        }),
      ],
    });
    const result = formatContentPlanForTim(plan);
    // All should be listed (format doesn't expose strategy, just operation type + heading)
    expect(result).toContain('"Team"');
    expect(result).toContain('"CV"');
    expect(result).toContain('"Custom"');
  });
});
