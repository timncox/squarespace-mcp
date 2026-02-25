/**
 * Layout Presets — named layouts that map to explicit Squarespace Fluid Engine grid coordinates.
 *
 * Squarespace grid system:
 * - 24 columns: X from 1-25 (start inclusive, end exclusive)
 * - Y from 0-N (rows, 0-based, end exclusive)
 * - Desktop only; mobile auto-reflows
 */

export interface LayoutSlot {
  startX: number;  // 1-based, inclusive
  endX: number;    // exclusive (max 25 for full width)
  startY: number;  // 0-based
  endY: number;    // exclusive
}

export interface LayoutPreset {
  name: string;
  description: string;
  slots: LayoutSlot[];
}

export const LAYOUT_PRESETS: Record<string, LayoutPreset> = {
  'full-width': {
    name: 'Full Width',
    description: 'Single block spanning full 24 columns',
    slots: [{ startX: 1, endX: 25, startY: 0, endY: 4 }],
  },
  'two-column': {
    name: 'Two Column',
    description: 'Two equal-width blocks side by side (12 cols each)',
    slots: [
      { startX: 1, endX: 13, startY: 0, endY: 4 },
      { startX: 13, endX: 25, startY: 0, endY: 4 },
    ],
  },
  'three-column': {
    name: 'Three Column',
    description: 'Three equal-width blocks (8 cols each)',
    slots: [
      { startX: 1, endX: 9, startY: 0, endY: 4 },
      { startX: 9, endX: 17, startY: 0, endY: 4 },
      { startX: 17, endX: 25, startY: 0, endY: 4 },
    ],
  },
  'hero-wide': {
    name: 'Hero Wide',
    description: 'Single full-width, tall block for hero text',
    slots: [{ startX: 1, endX: 25, startY: 0, endY: 8 }],
  },
  'sidebar-content': {
    name: 'Sidebar + Content',
    description: 'Narrow sidebar (8 cols) + wide content area (16 cols)',
    slots: [
      { startX: 1, endX: 9, startY: 0, endY: 6 },
      { startX: 9, endX: 25, startY: 0, endY: 6 },
    ],
  },
  'content-sidebar': {
    name: 'Content + Sidebar',
    description: 'Wide content area (16 cols) + narrow sidebar (8 cols)',
    slots: [
      { startX: 1, endX: 17, startY: 0, endY: 6 },
      { startX: 17, endX: 25, startY: 0, endY: 6 },
    ],
  },
  'card-grid-2x2': {
    name: 'Card Grid 2x2',
    description: 'Four blocks in a 2x2 grid',
    slots: [
      { startX: 1, endX: 13, startY: 0, endY: 4 },
      { startX: 13, endX: 25, startY: 0, endY: 4 },
      { startX: 1, endX: 13, startY: 6, endY: 10 },
      { startX: 13, endX: 25, startY: 6, endY: 10 },
    ],
  },
  'centered-narrow': {
    name: 'Centered Narrow',
    description: 'Centered block, 16 cols wide with margins',
    slots: [{ startX: 5, endX: 21, startY: 0, endY: 4 }],
  },
};

/**
 * Resolve a layout preset name to grid coordinates for N blocks.
 * If the preset has fewer slots than blocks, additional blocks are
 * stacked below the last row of the preset.
 * If the preset has more slots than blocks, only the first N slots are returned.
 * Returns null for unknown preset names.
 */
export function resolveLayoutPreset(
  presetName: string,
  blockCount: number,
): LayoutSlot[] | null {
  const preset = LAYOUT_PRESETS[presetName];
  if (!preset) return null;

  // Fewer blocks than slots — return only the needed slots
  if (blockCount <= preset.slots.length) {
    return preset.slots.slice(0, blockCount);
  }

  // More blocks than slots — use all preset slots, then stack extras below
  const result = [...preset.slots];
  const extraCount = blockCount - preset.slots.length;

  // Find the maximum Y extent from the preset slots to stack below
  let maxEndY = 0;
  for (const slot of preset.slots) {
    if (slot.endY > maxEndY) maxEndY = slot.endY;
  }

  // Determine the row pattern from the last row of the preset.
  // "Last row" = all slots sharing the highest startY value.
  let lastRowStartY = 0;
  for (const slot of preset.slots) {
    if (slot.startY > lastRowStartY) lastRowStartY = slot.startY;
  }
  const lastRowSlots = preset.slots.filter(s => s.startY === lastRowStartY);

  // Row height: consistent with existing rows (endY - startY of the last row)
  const rowHeight = lastRowSlots[0].endY - lastRowSlots[0].startY;

  // Gap between rows: distance from the last row's startY to maxEndY of previous rows
  // For a 2x2 grid with rows at Y=0-4 and Y=6-10, the gap is 2.
  // For single-row presets, use a default gap of 2.
  const prevRowMaxEndY = preset.slots
    .filter(s => s.startY < lastRowStartY)
    .reduce((max, s) => Math.max(max, s.endY), 0);
  const gap = prevRowMaxEndY > 0 ? (lastRowStartY - prevRowMaxEndY) : 2;

  // Repeat the last row pattern for extra blocks
  const slotsPerRow = lastRowSlots.length;
  let currentY = maxEndY + gap;

  for (let i = 0; i < extraCount; ) {
    for (let col = 0; col < slotsPerRow && i < extraCount; col++, i++) {
      const templateSlot = lastRowSlots[col];
      result.push({
        startX: templateSlot.startX,
        endX: templateSlot.endX,
        startY: currentY,
        endY: currentY + rowHeight,
      });
    }
    currentY += rowHeight + gap;
  }

  return result;
}

/**
 * Format presets for inclusion in the content strategist prompt.
 * Returns a markdown table of available presets with descriptions and slot counts.
 */
export function formatPresetsForPrompt(): string {
  const lines: string[] = [];

  lines.push('### Layout Presets for blank_api Sections');
  lines.push('');
  lines.push('When using `contentStrategy: "blank_api"`, you can specify a `layoutPreset` to control multi-column layouts. The execution pipeline resolves preset names into exact Squarespace Fluid Engine grid coordinates.');
  lines.push('');
  lines.push('| Preset Name | Description | Slots | Use When |');
  lines.push('| --- | --- | --- | --- |');

  const useCases: Record<string, string> = {
    'full-width': 'Default stacked text blocks',
    'two-column': 'Side-by-side content (skills + experience, bio + photo description)',
    'three-column': 'Three equal sections (services, features, team members)',
    'hero-wide': 'Large hero/banner text with more vertical space',
    'sidebar-content': 'Navigation or labels on left, main content on right',
    'content-sidebar': 'Main content on left, supplementary info on right',
    'card-grid-2x2': 'Four items in a grid (portfolio, services, testimonials)',
    'centered-narrow': 'Focused content with side margins (quotes, CTAs)',
  };

  for (const [key, preset] of Object.entries(LAYOUT_PRESETS)) {
    lines.push(`| \`${key}\` | ${preset.description} | ${preset.slots.length} | ${useCases[key] ?? ''} |`);
  }

  lines.push('');
  lines.push('**Usage**: Add `"layoutPreset": "two-column"` to the `content` object alongside `apiBlocks`. The number of `apiBlocks` should match the preset slot count (extra blocks stack below automatically).');
  lines.push('');
  lines.push('**Example** (two-column skills section):');
  lines.push('```json');
  lines.push('{');
  lines.push('  "contentStrategy": "blank_api",');
  lines.push('  "layoutPreset": "two-column",');
  lines.push('  "apiBlocks": [');
  lines.push('    { "html": "<h3>Technical Skills</h3><p>JavaScript, TypeScript, React...</p>" },');
  lines.push('    { "html": "<h3>Soft Skills</h3><p>Leadership, Communication...</p>" }');
  lines.push('  ]');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push('If no `layoutPreset` is specified, blocks are stacked full-width (default behavior).');

  return lines.join('\n');
}
