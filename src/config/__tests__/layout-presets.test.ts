import { describe, it, expect } from 'vitest';
import {
  LAYOUT_PRESETS,
  resolveLayoutPreset,
  formatPresetsForPrompt,
  type LayoutSlot,
} from '../layout-presets.js';

describe('LAYOUT_PRESETS', () => {
  it('has at least 6 presets', () => {
    expect(Object.keys(LAYOUT_PRESETS).length).toBeGreaterThanOrEqual(6);
  });

  it('all presets have slots within 24-column grid boundaries (startX >= 1, endX <= 25)', () => {
    for (const [name, preset] of Object.entries(LAYOUT_PRESETS)) {
      for (let i = 0; i < preset.slots.length; i++) {
        const slot = preset.slots[i];
        expect(slot.startX, `${name} slot[${i}].startX`).toBeGreaterThanOrEqual(1);
        expect(slot.endX, `${name} slot[${i}].endX`).toBeLessThanOrEqual(25);
        expect(slot.startX, `${name} slot[${i}] startX < endX`).toBeLessThan(slot.endX);
        expect(slot.startY, `${name} slot[${i}].startY`).toBeGreaterThanOrEqual(0);
        expect(slot.startY, `${name} slot[${i}] startY < endY`).toBeLessThan(slot.endY);
      }
    }
  });

  it('all presets have non-empty name and description', () => {
    for (const [key, preset] of Object.entries(LAYOUT_PRESETS)) {
      expect(preset.name, `${key}.name`).toBeTruthy();
      expect(preset.description, `${key}.description`).toBeTruthy();
      expect(preset.slots.length, `${key}.slots`).toBeGreaterThan(0);
    }
  });

  it('centered-narrow preset has centered columns', () => {
    const preset = LAYOUT_PRESETS['centered-narrow'];
    expect(preset).toBeDefined();
    expect(preset.slots).toHaveLength(1);
    const slot = preset.slots[0];
    // Centered means equal margins on both sides
    const leftMargin = slot.startX - 1;  // columns before block
    const rightMargin = 25 - slot.endX;   // columns after block (25 = max endX)
    expect(leftMargin).toBe(rightMargin);
    // And the block is narrower than full width
    expect(slot.endX - slot.startX).toBeLessThan(24);
  });
});

describe('resolveLayoutPreset', () => {
  it('returns null for unknown preset name', () => {
    expect(resolveLayoutPreset('nonexistent-preset', 2)).toBeNull();
    expect(resolveLayoutPreset('', 1)).toBeNull();
  });

  it('two-column with 2 blocks returns two side-by-side slots', () => {
    const slots = resolveLayoutPreset('two-column', 2);
    expect(slots).not.toBeNull();
    expect(slots!).toHaveLength(2);

    // First slot: left half
    expect(slots![0].startX).toBe(1);
    expect(slots![0].endX).toBe(13);
    // Second slot: right half
    expect(slots![1].startX).toBe(13);
    expect(slots![1].endX).toBe(25);
    // Same Y row
    expect(slots![0].startY).toBe(slots![1].startY);
    expect(slots![0].endY).toBe(slots![1].endY);
  });

  it('three-column with 3 blocks returns three equal slots', () => {
    const slots = resolveLayoutPreset('three-column', 3);
    expect(slots).not.toBeNull();
    expect(slots!).toHaveLength(3);

    // All on the same row
    expect(slots![0].startY).toBe(slots![1].startY);
    expect(slots![1].startY).toBe(slots![2].startY);

    // Equal widths (8 columns each)
    const width0 = slots![0].endX - slots![0].startX;
    const width1 = slots![1].endX - slots![1].startX;
    const width2 = slots![2].endX - slots![2].startX;
    expect(width0).toBe(8);
    expect(width1).toBe(8);
    expect(width2).toBe(8);

    // Contiguous (no gaps)
    expect(slots![0].endX).toBe(slots![1].startX);
    expect(slots![1].endX).toBe(slots![2].startX);

    // Span full width
    expect(slots![0].startX).toBe(1);
    expect(slots![2].endX).toBe(25);
  });

  it('card-grid-2x2 with 4 blocks returns 2x2 grid layout', () => {
    const slots = resolveLayoutPreset('card-grid-2x2', 4);
    expect(slots).not.toBeNull();
    expect(slots!).toHaveLength(4);

    // Row 1: slots 0 and 1 on the same Y
    expect(slots![0].startY).toBe(slots![1].startY);
    // Row 2: slots 2 and 3 on the same Y
    expect(slots![2].startY).toBe(slots![3].startY);
    // Row 2 is below row 1
    expect(slots![2].startY).toBeGreaterThan(slots![0].endY);

    // Left-right: slot 0 and 2 on the left, slot 1 and 3 on the right
    expect(slots![0].startX).toBe(slots![2].startX);
    expect(slots![1].startX).toBe(slots![3].startX);
  });

  it('with fewer blocks than slots returns only needed slots', () => {
    // card-grid-2x2 has 4 slots, request only 2
    const slots = resolveLayoutPreset('card-grid-2x2', 2);
    expect(slots).not.toBeNull();
    expect(slots!).toHaveLength(2);

    // Should be the first 2 slots (top row)
    expect(slots![0].startX).toBe(1);
    expect(slots![0].endX).toBe(13);
    expect(slots![1].startX).toBe(13);
    expect(slots![1].endX).toBe(25);
  });

  it('with 1 block returns only 1 slot from a multi-slot preset', () => {
    const slots = resolveLayoutPreset('three-column', 1);
    expect(slots).not.toBeNull();
    expect(slots!).toHaveLength(1);
    expect(slots![0].startX).toBe(1);
    expect(slots![0].endX).toBe(9);
  });

  it('with more blocks than slots stacks extras below', () => {
    // two-column has 2 slots, request 4
    const slots = resolveLayoutPreset('two-column', 4);
    expect(slots).not.toBeNull();
    expect(slots!).toHaveLength(4);

    // First two slots: original two-column layout
    expect(slots![0].startX).toBe(1);
    expect(slots![0].endX).toBe(13);
    expect(slots![1].startX).toBe(13);
    expect(slots![1].endX).toBe(25);

    // Extra slots: stacked below, repeating the column pattern
    expect(slots![2].startX).toBe(1);
    expect(slots![2].endX).toBe(13);
    expect(slots![3].startX).toBe(13);
    expect(slots![3].endX).toBe(25);

    // Extra row is below the first row (with a gap)
    expect(slots![2].startY).toBeGreaterThan(slots![0].endY);
    expect(slots![3].startY).toBeGreaterThan(slots![1].endY);

    // Extra slots have the same row height as original
    const originalHeight = slots![0].endY - slots![0].startY;
    const extraHeight = slots![2].endY - slots![2].startY;
    expect(extraHeight).toBe(originalHeight);
  });

  it('stacking extras from card-grid-2x2 produces a third row', () => {
    // card-grid-2x2 has 4 slots, request 6 (third row)
    const slots = resolveLayoutPreset('card-grid-2x2', 6);
    expect(slots).not.toBeNull();
    expect(slots!).toHaveLength(6);

    // Row 3 (slots 4 and 5) should be below row 2
    expect(slots![4].startY).toBeGreaterThan(slots![2].endY);
    expect(slots![4].startX).toBe(1);
    expect(slots![5].startX).toBe(13);
  });

  it('stacking extras from full-width produces stacked rows', () => {
    // full-width has 1 slot, request 3
    const slots = resolveLayoutPreset('full-width', 3);
    expect(slots).not.toBeNull();
    expect(slots!).toHaveLength(3);

    // All full-width
    for (const slot of slots!) {
      expect(slot.startX).toBe(1);
      expect(slot.endX).toBe(25);
    }

    // Each row below the previous
    expect(slots![1].startY).toBeGreaterThan(slots![0].endY);
    expect(slots![2].startY).toBeGreaterThan(slots![1].endY);
  });

  it('hero-wide with 1 block returns the tall full-width slot', () => {
    const slots = resolveLayoutPreset('hero-wide', 1);
    expect(slots).not.toBeNull();
    expect(slots!).toHaveLength(1);
    expect(slots![0].startX).toBe(1);
    expect(slots![0].endX).toBe(25);
    // Hero is taller than a standard slot
    const height = slots![0].endY - slots![0].startY;
    expect(height).toBe(8);
  });

  it('all preset slots have valid grid boundaries', () => {
    for (const presetName of Object.keys(LAYOUT_PRESETS)) {
      const slotCount = LAYOUT_PRESETS[presetName].slots.length;
      const slots = resolveLayoutPreset(presetName, slotCount);
      expect(slots, `${presetName} should resolve`).not.toBeNull();

      for (const slot of slots!) {
        expect(slot.startX).toBeGreaterThanOrEqual(1);
        expect(slot.endX).toBeLessThanOrEqual(25);
        expect(slot.startX).toBeLessThan(slot.endX);
        expect(slot.startY).toBeGreaterThanOrEqual(0);
        expect(slot.startY).toBeLessThan(slot.endY);
      }
    }
  });
});

describe('formatPresetsForPrompt', () => {
  it('returns non-empty string with all preset names', () => {
    const output = formatPresetsForPrompt();
    expect(output.length).toBeGreaterThan(0);

    for (const presetName of Object.keys(LAYOUT_PRESETS)) {
      expect(output, `should contain preset name "${presetName}"`).toContain(presetName);
    }
  });

  it('includes markdown table headers', () => {
    const output = formatPresetsForPrompt();
    expect(output).toContain('Preset Name');
    expect(output).toContain('Description');
    expect(output).toContain('Slots');
  });

  it('includes usage instructions', () => {
    const output = formatPresetsForPrompt();
    expect(output).toContain('layoutPreset');
    expect(output).toContain('blank_api');
  });

  it('includes the two-column example', () => {
    const output = formatPresetsForPrompt();
    expect(output).toContain('"two-column"');
    expect(output).toContain('apiBlocks');
  });
});
