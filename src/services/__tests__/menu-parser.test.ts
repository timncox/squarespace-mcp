import { describe, it, expect } from 'vitest';
import { parseMenuText, serializeMenu, MenuTab } from '../menu-parser.js';

// ── parseMenuText tests ─────────────────────────────────────────────────────

describe('parseMenuText', () => {
  it('parses a single tab with items', () => {
    const text = `Lunch
========

Burger
Juicy beef patty
$12

Salad
Fresh greens
$10`;

    const result = parseMenuText(text);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Lunch');
    expect(result[0].sections).toHaveLength(1);
    // Items without a section header get a null-title section
    expect(result[0].sections[0].title).toBeNull();
    expect(result[0].sections[0].items).toHaveLength(2);
    expect(result[0].sections[0].items[0]).toEqual({
      title: 'Burger',
      description: 'Juicy beef patty',
      variants: [{ price: '12' }],
    });
    expect(result[0].sections[0].items[1]).toEqual({
      title: 'Salad',
      description: 'Fresh greens',
      variants: [{ price: '10' }],
    });
  });

  it('parses multi-tab menu with ======== separators', () => {
    const text = `Lunch
========

Burger
$12

Dinner
========

Steak
$30`;

    const result = parseMenuText(text);
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe('Lunch');
    expect(result[1].title).toBe('Dinner');
    expect(result[0].sections[0].items[0].title).toBe('Burger');
    expect(result[1].sections[0].items[0].title).toBe('Steak');
  });

  it('parses sections within tabs using ------- headers', () => {
    const text = `Dinner
========

Appetizers
-------

Soup
$8

Mains
-------

Steak
$30`;

    const result = parseMenuText(text);
    expect(result).toHaveLength(1);
    expect(result[0].sections).toHaveLength(2);
    expect(result[0].sections[0].title).toBe('Appetizers');
    expect(result[0].sections[0].items).toHaveLength(1);
    expect(result[0].sections[0].items[0].title).toBe('Soup');
    expect(result[0].sections[1].title).toBe('Mains');
    expect(result[0].sections[1].items).toHaveLength(1);
    expect(result[0].sections[1].items[0].title).toBe('Steak');
  });

  it('parses items with inline prices (Power Lunch $28)', () => {
    const text = `Specials
========

Power Lunch $28
Happy Hour Wings $12`;

    const result = parseMenuText(text);
    expect(result[0].sections[0].items).toHaveLength(2);
    expect(result[0].sections[0].items[0]).toEqual({
      title: 'Power Lunch',
      description: null,
      variants: [{ price: '28' }],
    });
    expect(result[0].sections[0].items[1]).toEqual({
      title: 'Happy Hour Wings',
      description: null,
      variants: [{ price: '12' }],
    });
  });

  it('parses multi-variant prices ($24/46)', () => {
    const text = `Menu
========

Oysters
Half or full dozen
$24/46`;

    const result = parseMenuText(text);
    const item = result[0].sections[0].items[0];
    expect(item.title).toBe('Oysters');
    expect(item.description).toBe('Half or full dozen');
    expect(item.variants).toEqual([{ price: '24' }, { price: '46' }]);
  });

  it('parses three-way variant prices ($15/20/24)', () => {
    const text = `Menu
========

Wine
$15/20/24`;

    const result = parseMenuText(text);
    const item = result[0].sections[0].items[0];
    expect(item.variants).toEqual([
      { price: '15' },
      { price: '20' },
      { price: '24' },
    ]);
  });

  it('parses add-ons with + prefix', () => {
    const text = `Menu
========

Wagyu Burger
8oz patty with truffle aioli.
$24

+ Add Bacon $3
+ Add Egg $2`;

    const result = parseMenuText(text);
    const items = result[0].sections[0].items;
    expect(items).toHaveLength(3);
    expect(items[0].title).toBe('Wagyu Burger');
    expect(items[0].variants).toEqual([{ price: '24' }]);
    expect(items[1]).toEqual({
      title: '+ Add Bacon',
      description: null,
      variants: [{ price: '3' }],
    });
    expect(items[2]).toEqual({
      title: '+ Add Egg',
      description: null,
      variants: [{ price: '2' }],
    });
  });

  it('parses add-ons without price', () => {
    const text = `Menu
========

Steak
$30

+ Choice of Side`;

    const result = parseMenuText(text);
    const items = result[0].sections[0].items;
    expect(items).toHaveLength(2);
    expect(items[1]).toEqual({
      title: '+ Choice of Side',
      description: null,
      variants: [],
    });
  });

  it('parses supplemental fees (+$5 Supplemental Fee)', () => {
    const text = `Menu
========

Wagyu Steak
$65

+$5 Supplemental Fee`;

    const result = parseMenuText(text);
    const items = result[0].sections[0].items;
    expect(items).toHaveLength(2);
    expect(items[1]).toEqual({
      title: '+$5 Supplemental Fee',
      description: null,
      variants: [{ price: '5' }],
    });
  });

  it('parses tab descriptions (line after ========)', () => {
    const text = `Happy Hour
========
3pm To 6:30 Daily

Cocktails
-------

Margarita
$10`;

    const result = parseMenuText(text);
    expect(result[0].title).toBe('Happy Hour');
    expect(result[0].description).toBe('3pm To 6:30 Daily');
    expect(result[0].sections).toHaveLength(1);
    expect(result[0].sections[0].title).toBe('Cocktails');
  });

  it('parses items without section headers into a null-title section', () => {
    const text = `Kids Menu
========

Mac & Cheese
$8

Chicken Fingers
$9`;

    const result = parseMenuText(text);
    expect(result[0].sections).toHaveLength(1);
    expect(result[0].sections[0].title).toBeNull();
    expect(result[0].sections[0].items).toHaveLength(2);
  });

  it('handles items before and after section headers (mixed null + named sections)', () => {
    const text = `Happy Hour
========

Loaded Fries
$8

Cocktails
-------

Margarita
$10`;

    const result = parseMenuText(text);
    expect(result[0].sections).toHaveLength(2);
    expect(result[0].sections[0].title).toBeNull();
    expect(result[0].sections[0].items[0].title).toBe('Loaded Fries');
    expect(result[0].sections[1].title).toBe('Cocktails');
    expect(result[0].sections[1].items[0].title).toBe('Margarita');
  });

  it('parses multi-line descriptions (consecutive non-price lines after title)', () => {
    const text = `Menu
========

Chef's Special
Pan-seared salmon with a lemon butter sauce,
served with seasonal roasted vegetables.
$32`;

    const result = parseMenuText(text);
    const item = result[0].sections[0].items[0];
    expect(item.title).toBe("Chef's Special");
    expect(item.description).toBe(
      'Pan-seared salmon with a lemon butter sauce, served with seasonal roasted vegetables.',
    );
    expect(item.variants).toEqual([{ price: '32' }]);
  });

  it('parses items with description then price on next line', () => {
    const text = `Menu
========

Truffle Fries
Crispy fries with truffle oil and parmesan
$14`;

    const result = parseMenuText(text);
    const item = result[0].sections[0].items[0];
    expect(item.title).toBe('Truffle Fries');
    expect(item.description).toBe('Crispy fries with truffle oil and parmesan');
    expect(item.variants).toEqual([{ price: '14' }]);
  });

  it('returns [] for empty input', () => {
    expect(parseMenuText('')).toEqual([]);
  });

  it('returns [] for whitespace-only input', () => {
    expect(parseMenuText('   \n  \n   ')).toEqual([]);
  });

  it('handles unicode characters in item names and descriptions', () => {
    const text = `Caf\u00e9 Menu
========

Cr\u00e8me Br\u00fbl\u00e9e
Creamy vanilla custard with caramelized sugar
$12

P\u00e2t\u00e9 Maison
$18`;

    const result = parseMenuText(text);
    expect(result[0].title).toBe('Caf\u00e9 Menu');
    expect(result[0].sections[0].items[0].title).toBe('Cr\u00e8me Br\u00fbl\u00e9e');
    expect(result[0].sections[0].items[1].title).toBe('P\u00e2t\u00e9 Maison');
  });

  it('handles items with no price at all', () => {
    const text = `Menu
========

Specials
-------

Market Fish
Fresh catch of the day - ask your server`;

    const result = parseMenuText(text);
    const item = result[0].sections[0].items[0];
    expect(item.title).toBe('Market Fish');
    expect(item.description).toBe('Fresh catch of the day - ask your server');
    expect(item.variants).toEqual([]);
  });

  it('does not treat a line before a section header as tab description', () => {
    const text = `Lunch
========

Starters
-------

Soup
$8`;

    const result = parseMenuText(text);
    // "Starters" should NOT be treated as a tab description
    expect(result[0].description).toBeNull();
    expect(result[0].sections).toHaveLength(1);
    expect(result[0].sections[0].title).toBe('Starters');
  });

  it('handles price with trailing word like "$2 Each"', () => {
    const text = `Menu
========

Oysters
$2 Each`;

    const result = parseMenuText(text);
    const item = result[0].sections[0].items[0];
    expect(item.variants).toEqual([{ price: '2' }]);
  });

  it('handles multiple sections across multiple tabs (complex menu)', () => {
    const text = `Breakfast
========
Offered Monday thru Friday

Eggs
-------

Eggs Benedict
Classic hollandaise
$16

Omelette
Three eggs, choice of fillings
$14

Pastries
-------

Croissant
$5

Lunch
========

Sandwiches
-------

BLT
Bacon, lettuce, tomato on sourdough
$12

Club
Turkey, ham, swiss
$14`;

    const result = parseMenuText(text);
    expect(result).toHaveLength(2);

    // Breakfast tab
    expect(result[0].title).toBe('Breakfast');
    expect(result[0].description).toBe('Offered Monday thru Friday');
    expect(result[0].sections).toHaveLength(2);
    expect(result[0].sections[0].title).toBe('Eggs');
    expect(result[0].sections[0].items).toHaveLength(2);
    expect(result[0].sections[1].title).toBe('Pastries');
    expect(result[0].sections[1].items).toHaveLength(1);

    // Lunch tab
    expect(result[1].title).toBe('Lunch');
    expect(result[1].description).toBeNull();
    expect(result[1].sections).toHaveLength(1);
    expect(result[1].sections[0].title).toBe('Sandwiches');
    expect(result[1].sections[0].items).toHaveLength(2);
  });

  it('handles short === separator (minimum 3)', () => {
    const text = `Menu
===

Soup
$5`;

    const result = parseMenuText(text);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Menu');
  });

  it('handles short --- separator (minimum 3)', () => {
    const text = `Menu
========

Starters
---

Soup
$5`;

    const result = parseMenuText(text);
    expect(result[0].sections[0].title).toBe('Starters');
  });

  it('handles item followed immediately by another item (no blank line between, via price then title)', () => {
    const text = `Menu
========

Burger
$12
Salad
$10`;

    const result = parseMenuText(text);
    const items = result[0].sections[0].items;
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('Burger');
    expect(items[0].variants).toEqual([{ price: '12' }]);
    expect(items[1].title).toBe('Salad');
    expect(items[1].variants).toEqual([{ price: '10' }]);
  });
});

// ── serializeMenu tests ─────────────────────────────────────────────────────

describe('serializeMenu', () => {
  it('serializes a single tab with items', () => {
    const menus: MenuTab[] = [
      {
        title: 'Lunch',
        description: null,
        sections: [
          {
            title: null,
            description: null,
            items: [
              { title: 'Burger', description: 'Juicy patty', variants: [{ price: '12' }] },
              { title: 'Salad', description: null, variants: [{ price: '10' }] },
            ],
          },
        ],
      },
    ];

    const result = serializeMenu(menus);
    expect(result).toContain('Lunch\n========');
    expect(result).toContain('Burger\nJuicy patty\n$12');
    expect(result).toContain('Salad\n$10');
  });

  it('serializes add-ons with + prefix and price on same line', () => {
    const menus: MenuTab[] = [
      {
        title: 'Menu',
        description: null,
        sections: [
          {
            title: null,
            description: null,
            items: [
              { title: 'Burger', description: null, variants: [{ price: '12' }] },
              { title: '+ Add Bacon', description: null, variants: [{ price: '3' }] },
            ],
          },
        ],
      },
    ];

    const result = serializeMenu(menus);
    expect(result).toContain('+ Add Bacon $3');
    // Add-on should not have a blank line before it
    expect(result).toContain('$12\n+ Add Bacon $3');
  });

  it('serializes multi-variant prices as $24/46', () => {
    const menus: MenuTab[] = [
      {
        title: 'Menu',
        description: null,
        sections: [
          {
            title: null,
            description: null,
            items: [
              { title: 'Oysters', description: null, variants: [{ price: '24' }, { price: '46' }] },
            ],
          },
        ],
      },
    ];

    const result = serializeMenu(menus);
    expect(result).toContain('$24/46');
  });

  it('serializes three-way variant prices as $15/20/24', () => {
    const menus: MenuTab[] = [
      {
        title: 'Menu',
        description: null,
        sections: [
          {
            title: null,
            description: null,
            items: [
              {
                title: 'Wine',
                description: null,
                variants: [{ price: '15' }, { price: '20' }, { price: '24' }],
              },
            ],
          },
        ],
      },
    ];

    const result = serializeMenu(menus);
    expect(result).toContain('$15/20/24');
  });

  it('serializes tab descriptions', () => {
    const menus: MenuTab[] = [
      {
        title: 'Happy Hour',
        description: '3pm To 6:30 Daily',
        sections: [
          {
            title: 'Cocktails',
            description: null,
            items: [
              { title: 'Margarita', description: null, variants: [{ price: '10' }] },
            ],
          },
        ],
      },
    ];

    const result = serializeMenu(menus);
    expect(result).toContain('Happy Hour\n========\n3pm To 6:30 Daily');
  });

  it('serializes null-title sections (items without section header)', () => {
    const menus: MenuTab[] = [
      {
        title: 'Kids',
        description: null,
        sections: [
          {
            title: null,
            description: null,
            items: [
              { title: 'Mac & Cheese', description: null, variants: [{ price: '8' }] },
            ],
          },
        ],
      },
    ];

    const result = serializeMenu(menus);
    // Should NOT contain ------- for null-title sections
    expect(result).not.toContain('-------');
    expect(result).toContain('Mac & Cheese');
  });

  it('serializes section headers with -------', () => {
    const menus: MenuTab[] = [
      {
        title: 'Dinner',
        description: null,
        sections: [
          {
            title: 'Appetizers',
            description: null,
            items: [
              { title: 'Soup', description: null, variants: [{ price: '8' }] },
            ],
          },
          {
            title: 'Mains',
            description: null,
            items: [
              { title: 'Steak', description: null, variants: [{ price: '30' }] },
            ],
          },
        ],
      },
    ];

    const result = serializeMenu(menus);
    expect(result).toContain('Appetizers\n-------');
    expect(result).toContain('Mains\n-------');
  });

  it('returns empty string for empty menus', () => {
    expect(serializeMenu([])).toBe('');
  });

  it('returns empty string for null/undefined input', () => {
    expect(serializeMenu(null as any)).toBe('');
    expect(serializeMenu(undefined as any)).toBe('');
  });

  it('serializes add-ons without price', () => {
    const menus: MenuTab[] = [
      {
        title: 'Menu',
        description: null,
        sections: [
          {
            title: null,
            description: null,
            items: [
              { title: 'Steak', description: null, variants: [{ price: '30' }] },
              { title: '+ Choice of Side', description: null, variants: [] },
            ],
          },
        ],
      },
    ];

    const result = serializeMenu(menus);
    expect(result).toContain('+ Choice of Side');
    expect(result).not.toContain('+ Choice of Side $');
  });

  it('serializes supplemental fees', () => {
    const menus: MenuTab[] = [
      {
        title: 'Menu',
        description: null,
        sections: [
          {
            title: null,
            description: null,
            items: [
              { title: 'Wagyu Steak', description: null, variants: [{ price: '65' }] },
              { title: '+$5 Supplemental Fee', description: null, variants: [{ price: '5' }] },
            ],
          },
        ],
      },
    ];

    const result = serializeMenu(menus);
    expect(result).toContain('+$5 Supplemental Fee');
    // Supplemental fee should not have blank line before it
    expect(result).toContain('$65\n+$5 Supplemental Fee');
  });

  it('serializes multiple tabs separated by blank lines', () => {
    const menus: MenuTab[] = [
      {
        title: 'Lunch',
        description: null,
        sections: [
          { title: null, description: null, items: [{ title: 'Burger', description: null, variants: [{ price: '12' }] }] },
        ],
      },
      {
        title: 'Dinner',
        description: null,
        sections: [
          { title: null, description: null, items: [{ title: 'Steak', description: null, variants: [{ price: '30' }] }] },
        ],
      },
    ];

    const result = serializeMenu(menus);
    expect(result).toContain('Lunch\n========');
    expect(result).toContain('Dinner\n========');
    // Both tabs should be present
    expect(result).toContain('Burger');
    expect(result).toContain('Steak');
  });

  it('serializes items with no price', () => {
    const menus: MenuTab[] = [
      {
        title: 'Menu',
        description: null,
        sections: [
          {
            title: null,
            description: null,
            items: [
              { title: 'Market Fish', description: 'Ask your server', variants: [] },
            ],
          },
        ],
      },
    ];

    const result = serializeMenu(menus);
    expect(result).toContain('Market Fish\nAsk your server');
    expect(result).not.toContain('$');
  });
});

// ── Round-trip fidelity tests ───────────────────────────────────────────────

describe('round-trip: serializeMenu(parseMenuText(text))', () => {
  it('round-trips a simple menu', () => {
    const text = `Lunch
========

Burger
Juicy beef patty
$12

Salad
Fresh greens
$10`;

    const parsed = parseMenuText(text);
    const serialized = serializeMenu(parsed);
    const reparsed = parseMenuText(serialized);

    expect(reparsed).toEqual(parsed);
  });

  it('round-trips a menu with sections', () => {
    const text = `Dinner
========

Appetizers
-------

Soup
$8

Mains
-------

Steak
$30`;

    const parsed = parseMenuText(text);
    const serialized = serializeMenu(parsed);
    const reparsed = parseMenuText(serialized);

    expect(reparsed).toEqual(parsed);
  });

  it('round-trips a menu with add-ons', () => {
    const text = `Menu
========

Wagyu Burger
8oz patty with truffle aioli.
$24

+ Add Bacon $3
+ Add Egg $2`;

    const parsed = parseMenuText(text);
    const serialized = serializeMenu(parsed);
    const reparsed = parseMenuText(serialized);

    expect(reparsed).toEqual(parsed);
  });

  it('round-trips a menu with multi-variant prices', () => {
    const text = `Menu
========

Oysters
Half or full dozen
$24/46`;

    const parsed = parseMenuText(text);
    const serialized = serializeMenu(parsed);
    const reparsed = parseMenuText(serialized);

    expect(reparsed).toEqual(parsed);
  });

  it('round-trips a menu with tab descriptions', () => {
    const text = `Happy Hour
========
3pm To 6:30 Daily

Cocktails
-------

Margarita
$10`;

    const parsed = parseMenuText(text);
    const serialized = serializeMenu(parsed);
    const reparsed = parseMenuText(serialized);

    expect(reparsed).toEqual(parsed);
  });

  it('round-trips a complex multi-tab menu', () => {
    const text = `Breakfast
========
Offered Monday thru Friday

Eggs
-------

Eggs Benedict
Classic hollandaise
$16

Omelette
Three eggs, choice of fillings
$14

+ Add Bacon $3

Pastries
-------

Croissant
$5

Lunch
========

Sandwiches
-------

BLT
Bacon, lettuce, tomato on sourdough
$12

Club
Turkey, ham, swiss
$14`;

    const parsed = parseMenuText(text);
    const serialized = serializeMenu(parsed);
    const reparsed = parseMenuText(serialized);

    expect(reparsed).toEqual(parsed);
  });

  it('round-trips unicode characters', () => {
    const text = `Caf\u00e9 Menu
========

Cr\u00e8me Br\u00fbl\u00e9e
Creamy vanilla custard
$12`;

    const parsed = parseMenuText(text);
    const serialized = serializeMenu(parsed);
    const reparsed = parseMenuText(serialized);

    expect(reparsed).toEqual(parsed);
  });

  it('round-trips items with no prices', () => {
    const text = `Menu
========

Market Fish
Fresh catch of the day`;

    const parsed = parseMenuText(text);
    const serialized = serializeMenu(parsed);
    const reparsed = parseMenuText(serialized);

    expect(reparsed).toEqual(parsed);
  });
});
