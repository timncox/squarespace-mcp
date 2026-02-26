import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractMenuFromResponse, mergeMenuContent, mergeMenuStructured, mergeMenuFromText } from '../menu-merger.js';
import type { MenuTab, MenuSection, MenuItem } from '../menu-parser.js';

// ── Mock the Anthropic client ──────────────────────────────────────────
const mockCreate = vi.fn();
vi.mock('../../utils/anthropic-client.js', () => ({
  getAnthropicClient: () => ({
    messages: { create: mockCreate },
  }),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// For mergeMenuFromText, we need parseMenuText to actually work
// The mock for menu-parser needs to provide a working implementation
vi.mock('../menu-parser.js', async () => {
  // Simple inline parse for testing — just handles basic tab/section/item format
  function parseMenuText(text: string): any[] {
    if (!text || !text.trim()) return [];
    const tabs: any[] = [];
    let currentTab: any = null;
    let currentSection: any = null;
    let currentItem: any = null;
    const lines = text.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trimEnd();
      const nextLine = i + 1 < lines.length ? lines[i + 1].trimEnd() : '';
      if (nextLine.match(/^={3,}$/)) {
        if (currentItem && currentSection) { currentSection.items.push(currentItem); currentItem = null; }
        if (currentSection && currentTab) { currentTab.sections.push(currentSection); currentSection = null; }
        currentTab = { title: line.trim(), description: null, sections: [] };
        tabs.push(currentTab);
        i += 2;
        continue;
      }
      if (nextLine.match(/^-{3,}$/)) {
        if (currentItem && currentSection) { currentSection.items.push(currentItem); currentItem = null; }
        if (currentSection && currentTab) { currentTab.sections.push(currentSection); }
        currentSection = { title: line.trim(), description: null, items: [] };
        i += 2;
        continue;
      }
      if (line.trim() === '') {
        if (currentItem) {
          if (!currentSection && currentTab) { currentSection = { title: null, description: null, items: [] }; }
          if (currentSection) { currentSection.items.push(currentItem); currentItem = null; }
        }
        i++;
        continue;
      }
      if (!currentSection && currentTab) {
        currentSection = { title: null, description: null, items: [] };
      }
      if (line.trim().match(/^\$[\d,.\/]+/)) {
        if (currentItem) {
          const priceStr = line.trim().replace(/^\$/, '');
          currentItem.variants = priceStr.split('/').map((p: string) => ({ price: p.trim() }));
        }
        i++;
        continue;
      }
      if (currentItem === null) {
        currentItem = { title: line.trim(), description: null, variants: [] };
      } else if (currentItem.variants.length === 0) {
        currentItem.description = currentItem.description ? currentItem.description + ' ' + line.trim() : line.trim();
      } else {
        if (currentSection) { currentSection.items.push(currentItem); }
        currentItem = { title: line.trim(), description: null, variants: [] };
      }
      i++;
    }
    if (currentItem && currentSection) { currentSection.items.push(currentItem); }
    if (currentSection && currentTab) { currentTab.sections.push(currentSection); }
    return tabs;
  }
  return { parseMenuText };
});

// ── extractMenuFromResponse tests ──────────────────────────────────────

describe('extractMenuFromResponse', () => {
  it('extracts menu from ```text code block', () => {
    const response = `Here's the merged menu:

\`\`\`text
Lunch
========
Burger $12
Salad $10
\`\`\`

Let me know if you need changes.`;

    expect(extractMenuFromResponse(response)).toBe('Lunch\n========\nBurger $12\nSalad $10');
  });

  it('extracts menu from ```menu code block', () => {
    const response = `\`\`\`menu
Dinner
========
Steak $30
\`\`\``;

    expect(extractMenuFromResponse(response)).toBe('Dinner\n========\nSteak $30');
  });

  it('extracts menu from bare ``` code block', () => {
    const response = `\`\`\`
Brunch
========
Eggs Benedict $16
\`\`\``;

    expect(extractMenuFromResponse(response)).toBe('Brunch\n========\nEggs Benedict $16');
  });

  it('finds menu start by ======== line when preceded by explanation', () => {
    const response = `I've merged the menus. Here is the result:

Lunch
========
Appetizers
-------
Soup $8

Mains
-------
Burger $12`;

    const result = extractMenuFromResponse(response);
    expect(result.startsWith('Lunch\n========')).toBe(true);
    expect(result).toContain('Soup $8');
    expect(result).toContain('Burger $12');
    expect(result).not.toContain("I've merged");
  });

  it('returns plain text as-is when no code blocks or ========', () => {
    const response = `Appetizers
-------
Soup $8

Salad $10`;

    expect(extractMenuFromResponse(response)).toBe(response.trim());
  });

  it('trims whitespace from result', () => {
    const response = `  \n\nLunch\n========\nBurger $12\n\n  `;
    expect(extractMenuFromResponse(response)).toBe('Lunch\n========\nBurger $12');
  });

  it('handles empty string', () => {
    expect(extractMenuFromResponse('')).toBe('');
  });

  it('handles response with only explanation and no menu markers', () => {
    const response = 'The menu has been updated successfully with the new items.';
    expect(extractMenuFromResponse(response)).toBe(response.trim());
  });

  it('handles multiple ======== — takes from first one', () => {
    const response = `Some intro text here.

Lunch
========
Burger $12

Dinner
========
Steak $30`;

    const result = extractMenuFromResponse(response);
    expect(result.startsWith('Lunch\n========')).toBe(true);
    expect(result).toContain('Dinner\n========');
    expect(result).not.toContain('Some intro');
  });
});

// ── mergeMenuContent tests ─────────────────────────────────────────────

describe('mergeMenuContent', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('calls Anthropic API with correct model and prompt structure', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Lunch\n========\nBurger $12\nSalad $10\nFish Tacos $14' }],
    });

    const currentMenu = 'Lunch\n========\nBurger $12\nSalad $10';
    const updates = 'Add Fish Tacos $14 to the Lunch menu';

    await mergeMenuContent(currentMenu, updates);

    expect(mockCreate).toHaveBeenCalledOnce();
    const call = mockCreate.mock.calls[0][0];
    expect(call.model).toBe('claude-sonnet-4-20250514');
    expect(call.max_tokens).toBe(16384);
    expect(call.system).toContain('menu content merger');
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0].role).toBe('user');
    expect(call.messages[0].content).toContain('## Current Menu Block Content');
    expect(call.messages[0].content).toContain(currentMenu);
    expect(call.messages[0].content).toContain('## Updates To Apply');
    expect(call.messages[0].content).toContain(updates);
  });

  it('returns merged content from API response', async () => {
    const merged = 'Lunch\n========\nBurger $14\nSalad $10';
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: merged }],
    });

    const result = await mergeMenuContent('Lunch\n========\nBurger $12', 'Update Burger to $14');
    expect(result).toBe(merged);
  });

  it('strips markdown code fences from response', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '```text\nLunch\n========\nBurger $14\n```' }],
    });

    const result = await mergeMenuContent('Lunch\n========\nBurger $12', 'Update Burger to $14');
    expect(result).toBe('Lunch\n========\nBurger $14');
  });

  it('strips explanation preamble from response', async () => {
    mockCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: "Here's the merged menu:\n\nLunch\n========\nBurger $14",
      }],
    });

    const result = await mergeMenuContent('Lunch\n========\nBurger $12', 'Update price');
    expect(result).toBe('Lunch\n========\nBurger $14');
  });

  it('handles empty API response gracefully', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '' }],
    });

    const result = await mergeMenuContent('Lunch\n========\nBurger $12', 'some updates');
    expect(result).toBe('');
  });

  it('handles response with no text blocks', async () => {
    mockCreate.mockResolvedValue({
      content: [],
    });

    const result = await mergeMenuContent('Lunch\n========\nBurger $12', 'some updates');
    expect(result).toBe('');
  });

  it('includes system prompt with menu format rules', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'result' }],
    });

    await mergeMenuContent('menu', 'updates');

    const systemPrompt = mockCreate.mock.calls[0][0].system;
    expect(systemPrompt).toContain('========');
    expect(systemPrompt).toContain('-------');
    expect(systemPrompt).toContain('Preserve');
    expect(systemPrompt).toContain('Replace');
    expect(systemPrompt).toContain('Add');
    expect(systemPrompt).toContain('Remove');
    expect(systemPrompt).toContain('case-insensitive');
  });
});

// ── mergeMenuStructured tests ──────────────────────────────────────────

describe('mergeMenuStructured', () => {
  // Helper to create test data
  function makeTab(title: string, sections: MenuSection[] = [], description: string | null = null): MenuTab {
    return { title, description, sections };
  }
  function makeSection(title: string | null, items: MenuItem[] = [], description: string | null = null): MenuSection {
    return { title, description, items };
  }
  function makeItem(title: string, description: string | null = null, variants: Array<{ price: string }> = []): MenuItem {
    return { title, description, variants };
  }

  it('matches tabs by title (case-insensitive)', () => {
    const current = [
      makeTab('Lunch', [makeSection('Mains', [makeItem('Burger', 'Juicy beef', [{ price: '12' }])])]),
    ];
    const updates = [
      makeTab('lunch', [makeSection('Mains', [makeItem('Burger', 'Updated description', [{ price: '14' }])])]),
    ];

    const result = mergeMenuStructured(current, updates);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Lunch'); // Keeps original casing
    expect(result[0].sections[0].items[0].description).toBe('Updated description');
    expect(result[0].sections[0].items[0].variants[0].price).toBe('14');
  });

  it('appends unmatched tabs from updates', () => {
    const current = [
      makeTab('Lunch', [makeSection('Mains', [makeItem('Burger')])]),
    ];
    const updates = [
      makeTab('Dinner', [makeSection('Entrees', [makeItem('Steak')])]),
    ];

    const result = mergeMenuStructured(current, updates);

    expect(result).toHaveLength(2);
    expect(result[0].title).toBe('Lunch');
    expect(result[1].title).toBe('Dinner');
    expect(result[1].sections[0].items[0].title).toBe('Steak');
  });

  it('matches sections by title within tabs', () => {
    const current = [
      makeTab('Lunch', [
        makeSection('Appetizers', [makeItem('Soup', 'Tomato', [{ price: '8' }])]),
        makeSection('Mains', [makeItem('Burger', 'Beef', [{ price: '12' }])]),
      ]),
    ];
    const updates = [
      makeTab('Lunch', [
        makeSection('appetizers', [makeItem('Soup', 'French onion', [{ price: '9' }])]),
      ]),
    ];

    const result = mergeMenuStructured(current, updates);

    expect(result[0].sections).toHaveLength(2);
    expect(result[0].sections[0].items[0].description).toBe('French onion');
    expect(result[0].sections[0].items[0].variants[0].price).toBe('9');
    // Mains untouched
    expect(result[0].sections[1].items[0].title).toBe('Burger');
    expect(result[0].sections[1].items[0].description).toBe('Beef');
  });

  it('appends unmatched sections from updates', () => {
    const current = [
      makeTab('Lunch', [
        makeSection('Mains', [makeItem('Burger')]),
      ]),
    ];
    const updates = [
      makeTab('Lunch', [
        makeSection('Desserts', [makeItem('Cake')]),
      ]),
    ];

    const result = mergeMenuStructured(current, updates);

    expect(result[0].sections).toHaveLength(2);
    expect(result[0].sections[0].title).toBe('Mains');
    expect(result[0].sections[1].title).toBe('Desserts');
    expect(result[0].sections[1].items[0].title).toBe('Cake');
  });

  it('matches items by title within sections', () => {
    const current = [
      makeTab('Lunch', [
        makeSection('Mains', [
          makeItem('Burger', 'Classic beef', [{ price: '12' }]),
          makeItem('Salad', 'Garden fresh', [{ price: '10' }]),
        ]),
      ]),
    ];
    const updates = [
      makeTab('Lunch', [
        makeSection('Mains', [
          makeItem('burger', 'Wagyu beef', [{ price: '18' }]),
        ]),
      ]),
    ];

    const result = mergeMenuStructured(current, updates);

    expect(result[0].sections[0].items).toHaveLength(2);
    expect(result[0].sections[0].items[0].title).toBe('Burger'); // Keeps original casing
    expect(result[0].sections[0].items[0].description).toBe('Wagyu beef');
    expect(result[0].sections[0].items[0].variants[0].price).toBe('18');
    // Salad untouched
    expect(result[0].sections[0].items[1].title).toBe('Salad');
    expect(result[0].sections[0].items[1].description).toBe('Garden fresh');
  });

  it('appends unmatched items from updates', () => {
    const current = [
      makeTab('Lunch', [
        makeSection('Mains', [
          makeItem('Burger', 'Classic beef', [{ price: '12' }]),
        ]),
      ]),
    ];
    const updates = [
      makeTab('Lunch', [
        makeSection('Mains', [
          makeItem('Fish Tacos', 'Baja style', [{ price: '14' }]),
        ]),
      ]),
    ];

    const result = mergeMenuStructured(current, updates);

    expect(result[0].sections[0].items).toHaveLength(2);
    expect(result[0].sections[0].items[0].title).toBe('Burger');
    expect(result[0].sections[0].items[1].title).toBe('Fish Tacos');
    expect(result[0].sections[0].items[1].description).toBe('Baja style');
    expect(result[0].sections[0].items[1].variants[0].price).toBe('14');
  });

  it('updates description for matched items when update has non-null description', () => {
    const current = [
      makeTab('Lunch', [
        makeSection('Mains', [
          makeItem('Burger', 'Old description', [{ price: '12' }]),
        ]),
      ]),
    ];
    const updates = [
      makeTab('Lunch', [
        makeSection('Mains', [
          makeItem('Burger', 'New description'),
        ]),
      ]),
    ];

    const result = mergeMenuStructured(current, updates);

    expect(result[0].sections[0].items[0].description).toBe('New description');
    // Variants kept since update has empty array
    expect(result[0].sections[0].items[0].variants[0].price).toBe('12');
  });

  it('keeps current description when update description is null', () => {
    const current = [
      makeTab('Lunch', [
        makeSection('Mains', [
          makeItem('Burger', 'Juicy beef burger', [{ price: '12' }]),
        ]),
      ]),
    ];
    const updates = [
      makeTab('Lunch', [
        makeSection('Mains', [
          makeItem('Burger', null, [{ price: '14' }]),
        ]),
      ]),
    ];

    const result = mergeMenuStructured(current, updates);

    expect(result[0].sections[0].items[0].description).toBe('Juicy beef burger');
    expect(result[0].sections[0].items[0].variants[0].price).toBe('14');
  });

  it('overrides variants for matched items', () => {
    const current = [
      makeTab('Lunch', [
        makeSection('Mains', [
          makeItem('Steak', 'Grilled', [{ price: '24' }, { price: '46' }]),
        ]),
      ]),
    ];
    const updates = [
      makeTab('Lunch', [
        makeSection('Mains', [
          makeItem('Steak', null, [{ price: '28' }, { price: '50' }]),
        ]),
      ]),
    ];

    const result = mergeMenuStructured(current, updates);

    expect(result[0].sections[0].items[0].variants).toHaveLength(2);
    expect(result[0].sections[0].items[0].variants[0].price).toBe('28');
    expect(result[0].sections[0].items[0].variants[1].price).toBe('50');
  });

  it('keeps current variants when update has empty variants', () => {
    const current = [
      makeTab('Lunch', [
        makeSection('Mains', [
          makeItem('Steak', 'Grilled', [{ price: '24' }]),
        ]),
      ]),
    ];
    const updates = [
      makeTab('Lunch', [
        makeSection('Mains', [
          makeItem('Steak', 'Pan-seared'),
        ]),
      ]),
    ];

    const result = mergeMenuStructured(current, updates);

    expect(result[0].sections[0].items[0].description).toBe('Pan-seared');
    expect(result[0].sections[0].items[0].variants).toHaveLength(1);
    expect(result[0].sections[0].items[0].variants[0].price).toBe('24');
  });

  it('handles empty current — returns clone of updates', () => {
    const updates = [
      makeTab('Dinner', [
        makeSection('Entrees', [makeItem('Steak', 'Grilled', [{ price: '30' }])]),
      ]),
    ];

    const result = mergeMenuStructured([], updates);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Dinner');
    expect(result[0].sections[0].items[0].title).toBe('Steak');
    // Verify it's a clone, not the same reference
    expect(result[0]).not.toBe(updates[0]);
  });

  it('handles empty updates — returns clone of current', () => {
    const current = [
      makeTab('Lunch', [
        makeSection('Mains', [makeItem('Burger', 'Classic', [{ price: '12' }])]),
      ]),
    ];

    const result = mergeMenuStructured(current, []);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Lunch');
    expect(result[0].sections[0].items[0].title).toBe('Burger');
    // Verify it's a clone, not the same reference
    expect(result[0]).not.toBe(current[0]);
  });

  it('deep clones inputs — mutations do not affect originals', () => {
    const current = [
      makeTab('Lunch', [
        makeSection('Mains', [makeItem('Burger', 'Classic', [{ price: '12' }])]),
      ]),
    ];
    const updates = [
      makeTab('Lunch', [
        makeSection('Mains', [makeItem('Burger', 'Updated', [{ price: '14' }])]),
      ]),
    ];

    const result = mergeMenuStructured(current, updates);

    // Mutate result
    result[0].title = 'MUTATED';
    result[0].sections[0].items[0].description = 'MUTATED';

    // Originals unchanged
    expect(current[0].title).toBe('Lunch');
    expect(current[0].sections[0].items[0].description).toBe('Classic');
    expect(updates[0].title).toBe('Lunch');
    expect(updates[0].sections[0].items[0].description).toBe('Updated');
  });

  it('handles tabs with null-title sections', () => {
    const current = [
      makeTab('Happy Hour', [
        makeSection(null, [makeItem('Wings', 'Buffalo', [{ price: '8' }])]),
        makeSection('Cocktails', [makeItem('Margarita', null, [{ price: '10' }])]),
      ]),
    ];
    const updates = [
      makeTab('Happy Hour', [
        makeSection(null, [makeItem('Nachos', 'Loaded', [{ price: '9' }])]),
      ]),
    ];

    const result = mergeMenuStructured(current, updates);

    // Null-title sections match each other ('' === '')
    expect(result[0].sections).toHaveLength(2);
    expect(result[0].sections[0].title).toBeNull();
    expect(result[0].sections[0].items).toHaveLength(2); // Wings + Nachos
    expect(result[0].sections[0].items[0].title).toBe('Wings');
    expect(result[0].sections[0].items[1].title).toBe('Nachos');
    // Cocktails section untouched
    expect(result[0].sections[1].title).toBe('Cocktails');
  });

  it('updates tab description when update provides one', () => {
    const current = [
      makeTab('Lunch', [makeSection('Mains', [makeItem('Burger')])], 'Served 11am-3pm'),
    ];
    const updates = [
      makeTab('Lunch', [], 'Served 11am-4pm'),
    ];

    const result = mergeMenuStructured(current, updates);

    expect(result[0].description).toBe('Served 11am-4pm');
    // Sections preserved
    expect(result[0].sections).toHaveLength(1);
    expect(result[0].sections[0].items[0].title).toBe('Burger');
  });

  it('keeps tab description when update description is null', () => {
    const current = [
      makeTab('Lunch', [makeSection('Mains', [makeItem('Burger')])], 'Served 11am-3pm'),
    ];
    const updates = [
      makeTab('Lunch', [makeSection('Mains', [makeItem('Salad')])], null),
    ];

    const result = mergeMenuStructured(current, updates);

    expect(result[0].description).toBe('Served 11am-3pm');
    expect(result[0].sections[0].items).toHaveLength(2); // Burger + Salad
  });

  it('updates section description when update provides one', () => {
    const current = [
      makeTab('Lunch', [
        makeSection('Appetizers', [makeItem('Soup')], 'Small plates to share'),
      ]),
    ];
    const updates = [
      makeTab('Lunch', [
        makeSection('Appetizers', [], 'Perfect for sharing'),
      ]),
    ];

    const result = mergeMenuStructured(current, updates);

    expect(result[0].sections[0].description).toBe('Perfect for sharing');
    // Items preserved
    expect(result[0].sections[0].items).toHaveLength(1);
    expect(result[0].sections[0].items[0].title).toBe('Soup');
  });
});

// ── mergeMenuFromText tests ────────────────────────────────────────────

describe('mergeMenuFromText', () => {
  it('parses text and merges with current menus', () => {
    const current: MenuTab[] = [
      {
        title: 'Lunch',
        description: null,
        sections: [
          {
            title: 'Mains',
            description: null,
            items: [
              { title: 'Burger', description: 'Classic beef', variants: [{ price: '12' }] },
            ],
          },
        ],
      },
    ];

    const updateText = `Lunch
========

Mains
-------

Burger
Wagyu beef
$18`;

    const result = mergeMenuFromText(current, updateText);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Lunch');
    expect(result[0].sections[0].items[0].title).toBe('Burger');
    expect(result[0].sections[0].items[0].description).toBe('Wagyu beef');
    expect(result[0].sections[0].items[0].variants[0].price).toBe('18');
  });

  it('handles empty update text', () => {
    const current: MenuTab[] = [
      {
        title: 'Lunch',
        description: null,
        sections: [
          {
            title: 'Mains',
            description: null,
            items: [
              { title: 'Burger', description: 'Classic', variants: [{ price: '12' }] },
            ],
          },
        ],
      },
    ];

    const result = mergeMenuFromText(current, '');

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Lunch');
    expect(result[0].sections[0].items[0].title).toBe('Burger');
    expect(result[0].sections[0].items[0].description).toBe('Classic');
  });

  it('appends new items from parsed text', () => {
    const current: MenuTab[] = [
      {
        title: 'Lunch',
        description: null,
        sections: [
          {
            title: 'Mains',
            description: null,
            items: [
              { title: 'Burger', description: 'Classic', variants: [{ price: '12' }] },
            ],
          },
        ],
      },
    ];

    const updateText = `Lunch
========

Mains
-------

Fish Tacos
Baja style
$14`;

    const result = mergeMenuFromText(current, updateText);

    expect(result[0].sections[0].items).toHaveLength(2);
    expect(result[0].sections[0].items[0].title).toBe('Burger');
    expect(result[0].sections[0].items[1].title).toBe('Fish Tacos');
    expect(result[0].sections[0].items[1].description).toBe('Baja style');
    expect(result[0].sections[0].items[1].variants[0].price).toBe('14');
  });
});
