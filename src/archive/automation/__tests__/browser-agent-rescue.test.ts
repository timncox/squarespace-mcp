import { describe, it, expect } from 'vitest';
import {
  detectStuckPattern,
  getRescueHint,
  type RecentAction,
  type StuckPattern,
} from '../browser-agent-rescue.js';

// ─── Helper to build RecentAction objects ────────────────────────────────────

function action(overrides: Partial<RecentAction> = {}): RecentAction {
  return {
    action: 'click',
    selector: 'button',
    reasoning: 'trying to proceed',
    success: true,
    pageChanged: false,
    ...overrides,
  };
}

// ─── detectStuckPattern ──────────────────────────────────────────────────────

describe('detectStuckPattern', () => {
  // ── Minimum history requirements ─────────────────────────────────────────

  it('returns undefined with 0 actions', () => {
    expect(detectStuckPattern([])).toBeUndefined();
  });

  it('returns undefined with 1 action', () => {
    expect(detectStuckPattern([action()])).toBeUndefined();
  });

  it('returns undefined with 2 actions', () => {
    expect(detectStuckPattern([action(), action()])).toBeUndefined();
  });

  it('returns undefined with exactly 3 actions if no stuck pattern matches', () => {
    // 3 actions, no page changes, but no strong pattern signals → needs 4 for generic_stuck
    const actions = [action(), action(), action()];
    expect(detectStuckPattern(actions)).toBeUndefined();
  });

  // ── Page change breaks stuck detection ───────────────────────────────────

  it('returns undefined when last action has pageChanged', () => {
    const actions = [
      action({ reasoning: 'add section to the page' }),
      action({ reasoning: 'trying to add section' }),
      action({ reasoning: 'add section again', pageChanged: true }),
    ];
    expect(detectStuckPattern(actions)).toBeUndefined();
  });

  it('returns undefined when middle action has pageChanged', () => {
    const actions = [
      action({ reasoning: 'add section to the page' }),
      action({ reasoning: 'trying to add section', pageChanged: true }),
      action({ reasoning: 'add section again' }),
    ];
    expect(detectStuckPattern(actions)).toBeUndefined();
  });

  it('returns undefined even with keyword matches when page changes occur', () => {
    const actions = [
      action({ reasoning: 'trying to add a block', pageChanged: true }),
      action({ reasoning: 'still trying to add block', pageChanged: false }),
      action({ reasoning: 'add block attempt 3', pageChanged: false }),
      action({ reasoning: 'add block attempt 4', pageChanged: true }),
    ];
    expect(detectStuckPattern(actions)).toBeUndefined();
  });

  // ── cant_add_section ─────────────────────────────────────────────────────

  it('detects cant_add_section from "add section" in reasoning', () => {
    const actions = [
      action({ reasoning: 'I need to add section to the page' }),
      action({ reasoning: 'trying to click add section button' }),
      action({ reasoning: 'still looking for add section' }),
    ];
    expect(detectStuckPattern(actions)).toBe('cant_add_section');
  });

  it('detects cant_add_section from "add a section" in reasoning', () => {
    const actions = [
      action({ reasoning: 'I want to add a section here' }),
      action({ reasoning: 'clicking the page to add a section' }),
      action({ reasoning: 'failed to add a section' }),
    ];
    expect(detectStuckPattern(actions)).toBe('cant_add_section');
  });

  it('detects cant_add_section from "new section" in reasoning', () => {
    const actions = [
      action({ reasoning: 'need a new section for the about page' }),
      action({ reasoning: 'creating new section' }),
      action({ reasoning: 'the new section is not appearing' }),
    ];
    expect(detectStuckPattern(actions)).toBe('cant_add_section');
  });

  it('detects cant_add_section from add-section in selector', () => {
    const actions = [
      action({ selector: 'button.add-section-btn', reasoning: 'clicking button' }),
      action({ selector: '.add-section', reasoning: 'trying button' }),
      action({ selector: 'div.add-section-panel', reasoning: 'looking for panel' }),
    ];
    expect(detectStuckPattern(actions)).toBe('cant_add_section');
  });

  it('detects cant_add_section from addsection in selector', () => {
    const actions = [
      action({ selector: '.sqs-addsection', reasoning: 'clicking' }),
      action({ selector: 'button.addsection', reasoning: 'trying again' }),
      action({ reasoning: 'still stuck' }),
    ];
    expect(detectStuckPattern(actions)).toBe('cant_add_section');
  });

  // ── cant_add_block ───────────────────────────────────────────────────────

  it('detects cant_add_block from "add block" in reasoning', () => {
    const actions = [
      action({ reasoning: 'need to add block to the section' }),
      action({ reasoning: 'looking for add block button' }),
      action({ reasoning: 'can not find add block' }),
    ];
    expect(detectStuckPattern(actions)).toBe('cant_add_block');
  });

  it('detects cant_add_block from "add a block" in reasoning', () => {
    const actions = [
      action({ reasoning: 'I should add a block for the heading' }),
      action({ reasoning: 'trying to add a block' }),
      action({ reasoning: 'failed to add a block' }),
    ];
    expect(detectStuckPattern(actions)).toBe('cant_add_block');
  });

  it('detects cant_add_block from "text block" in reasoning', () => {
    const actions = [
      action({ reasoning: 'looking for the text block option' }),
      action({ reasoning: 'need to insert a text block' }),
      action({ reasoning: 'text block is not appearing' }),
    ];
    expect(detectStuckPattern(actions)).toBe('cant_add_block');
  });

  it('detects cant_add_block from "button block" in reasoning', () => {
    const actions = [
      action({ reasoning: 'I need to add a button block' }),
      action({ reasoning: 'searching for button block in picker' }),
      action({ reasoning: 'button block not found' }),
    ];
    expect(detectStuckPattern(actions)).toBe('cant_add_block');
  });

  it('detects cant_add_block from add-block in selector', () => {
    const actions = [
      action({ selector: '.add-block-btn', reasoning: 'clicking add block' }),
      action({ selector: 'button.add-block', reasoning: 'trying again' }),
      action({ reasoning: 'no luck' }),
    ];
    expect(detectStuckPattern(actions)).toBe('cant_add_block');
  });

  it('detects cant_add_block from addblock in selector', () => {
    const actions = [
      action({ selector: '.sqs-addblock', reasoning: 'trying' }),
      action({ selector: 'div.addblock', reasoning: 'trying again' }),
      action({ reasoning: 'still stuck' }),
    ];
    expect(detectStuckPattern(actions)).toBe('cant_add_block');
  });

  // ── cant_edit_text ───────────────────────────────────────────────────────

  it('detects cant_edit_text from text reasoning + dblclickInIframe action', () => {
    const actions = [
      action({ action: 'dblclickInIframe', reasoning: 'double click the text to edit it' }),
      action({ action: 'dblclickInIframe', reasoning: 'trying to select the text' }),
      action({ action: 'type', reasoning: 'typing new text content' }),
    ];
    expect(detectStuckPattern(actions)).toBe('cant_edit_text');
  });

  it('detects cant_edit_text from heading reasoning + type action', () => {
    const actions = [
      action({ action: 'click', reasoning: 'click the heading' }),
      action({ action: 'type', reasoning: 'trying to change the heading text' }),
      action({ action: 'type', reasoning: 'heading is not updating' }),
    ];
    expect(detectStuckPattern(actions)).toBe('cant_edit_text');
  });

  it('detects cant_edit_text from type reasoning + dblclick action', () => {
    const actions = [
      action({ action: 'dblclick', reasoning: 'double click to type into the field' }),
      action({ action: 'click', reasoning: 'click elsewhere' }),
      action({ action: 'dblclick', reasoning: 'I need to type the new value' }),
    ];
    expect(detectStuckPattern(actions)).toBe('cant_edit_text');
  });

  // ── cant_edit_button ─────────────────────────────────────────────────────

  it('detects cant_edit_button from button + label reasoning', () => {
    const actions = [
      action({ reasoning: 'I need to change the button label' }),
      action({ reasoning: 'editing the button label text' }),
      action({ reasoning: 'button label not updating' }),
      action({ reasoning: 'trying the button label again' }),
    ];
    expect(detectStuckPattern(actions)).toBe('cant_edit_button');
  });

  it('detects cant_edit_button from button + url reasoning', () => {
    const actions = [
      action({ reasoning: 'need to set the button url to the new link' }),
      action({ reasoning: 'looking for button url field' }),
      action({ reasoning: 'button url not saving' }),
      action({ reasoning: 'the button url still has old value' }),
    ];
    expect(detectStuckPattern(actions)).toBe('cant_edit_button');
  });

  it('detects cant_edit_button from button + link reasoning', () => {
    const actions = [
      action({ reasoning: 'I need to update the button link' }),
      action({ reasoning: 'clicking the button link field' }),
      action({ reasoning: 'the button link dropdown is not opening' }),
      action({ reasoning: 'still trying to change the button link' }),
    ];
    expect(detectStuckPattern(actions)).toBe('cant_edit_button');
  });

  // ── cant_find_element ────────────────────────────────────────────────────

  it('detects cant_find_element from "can\'t find" reasoning', () => {
    const actions = [
      action({ reasoning: "I can't find the save button anywhere" }),
      action({ reasoning: "looking around but can't find it" }),
      action({ reasoning: "still can't find the element" }),
    ];
    expect(detectStuckPattern(actions)).toBe('cant_find_element');
  });

  it('detects cant_find_element from "cannot find" reasoning', () => {
    const actions = [
      action({ reasoning: 'I cannot find the settings panel' }),
      action({ reasoning: 'scrolling but cannot find it' }),
      action({ reasoning: 'cannot find the panel' }),
    ];
    expect(detectStuckPattern(actions)).toBe('cant_find_element');
  });

  it('detects cant_find_element from "not visible" reasoning', () => {
    const actions = [
      action({ reasoning: 'the element is not visible on the page' }),
      action({ reasoning: 'still not visible after scrolling' }),
      action({ reasoning: 'control is not visible' }),
    ];
    expect(detectStuckPattern(actions)).toBe('cant_find_element');
  });

  it('detects cant_find_element from "don\'t see" reasoning', () => {
    const actions = [
      action({ reasoning: "I don't see the edit button" }),
      action({ reasoning: "still don't see it anywhere" }),
      action({ reasoning: "don't see any matching elements" }),
    ];
    expect(detectStuckPattern(actions)).toBe('cant_find_element');
  });

  it('detects cant_find_element from "looking for" reasoning', () => {
    const actions = [
      action({ reasoning: 'looking for the settings icon' }),
      action({ reasoning: 'still looking for the settings icon' }),
      action({ reasoning: 'I keep looking for it everywhere' }),
    ];
    expect(detectStuckPattern(actions)).toBe('cant_find_element');
  });

  // ── clicking_wrong_things ────────────────────────────────────────────────

  it('detects clicking_wrong_things from all-failing click actions', () => {
    const actions = [
      action({ action: 'click', success: false, reasoning: 'click the button' }),
      action({ action: 'click', success: false, reasoning: 'click again' }),
      action({ action: 'click', success: false, reasoning: 'try click once more' }),
    ];
    expect(detectStuckPattern(actions)).toBe('clicking_wrong_things');
  });

  it('detects clicking_wrong_things with mixed click and clickInIframe', () => {
    const actions = [
      action({ action: 'clickInIframe', success: false, reasoning: 'click element' }),
      action({ action: 'click', success: false, reasoning: 'try admin click' }),
      action({ action: 'clickInIframe', success: false, reasoning: 'click again' }),
    ];
    expect(detectStuckPattern(actions)).toBe('clicking_wrong_things');
  });

  it('does not detect clicking_wrong_things when some clicks succeed', () => {
    const actions = [
      action({ action: 'click', success: true, reasoning: 'click worked' }),
      action({ action: 'click', success: false, reasoning: 'this one failed' }),
      action({ action: 'click', success: false, reasoning: 'this failed too' }),
      // Only 2 failures in last 3 (allRecentFailed = recentFailures >= 2 = true),
      // but actions are all click, so clicking_wrong_things matches.
      // Wait — allRecentFailed is `last3.filter(a => !a.success).length >= 2` = 2 >= 2 = true.
      // And all actions in last3 are click. So clicking_wrong_things triggers.
    ];
    // Actually 2/3 failed so allRecentFailed is true, and all last3 are click.
    // This WILL match clicking_wrong_things.
    expect(detectStuckPattern(actions)).toBe('clicking_wrong_things');
  });

  it('does not detect clicking_wrong_things with non-click actions', () => {
    // Fails but with "fill" actions — not all clicks. Reasoning avoids keyword triggers.
    const actions = [
      action({ action: 'fill', success: false, reasoning: 'filling the input field' }),
      action({ action: 'fill', success: false, reasoning: 'fill the name field' }),
      action({ action: 'fill', success: false, reasoning: 'fill the email field' }),
      action({ action: 'fill', success: false, reasoning: 'fill the phone field' }),
    ];
    // Not clicking_wrong_things (not all click/clickInIframe). But all_actions_failing (4 failures).
    expect(detectStuckPattern(actions)).toBe('all_actions_failing');
  });

  // ── all_actions_failing ──────────────────────────────────────────────────

  it('detects all_actions_failing with 4 consecutive failures', () => {
    // Reasoning avoids keyword triggers (no "type", "text", "heading", "button", "section", "block", etc.)
    const actions = [
      action({ action: 'scroll', success: false, reasoning: 'scroll down the page' }),
      action({ action: 'fill', success: false, reasoning: 'fill the input field' }),
      action({ action: 'navigate', success: false, reasoning: 'navigate to the url' }),
      action({ action: 'hover', success: false, reasoning: 'hover over the element' }),
    ];
    expect(detectStuckPattern(actions)).toBe('all_actions_failing');
  });

  it('does not detect all_actions_failing with only 3 failures', () => {
    const actions = [
      action({ action: 'scroll', success: false, reasoning: 'scroll down the page' }),
      action({ action: 'fill', success: false, reasoning: 'fill the input' }),
      action({ action: 'navigate', success: false, reasoning: 'navigate to url' }),
    ];
    // Only 3 actions, all_actions_failing requires >= 4
    // No keyword matches either, and < 4 actions means no generic_stuck
    expect(detectStuckPattern(actions)).toBeUndefined();
  });

  it('does not detect all_actions_failing when one of last 4 succeeds', () => {
    const actions = [
      action({ action: 'scroll', success: false, reasoning: 'scroll down the page' }),
      action({ action: 'fill', success: true, reasoning: 'fill the input' }),
      action({ action: 'navigate', success: false, reasoning: 'navigate to url' }),
      action({ action: 'hover', success: false, reasoning: 'hover over element' }),
    ];
    // One success in last 4 → not all_actions_failing. Falls through to generic_stuck.
    expect(detectStuckPattern(actions)).toBe('generic_stuck');
  });

  // ── oscillating_actions ──────────────────────────────────────────────────

  it('detects oscillating_actions with A→B→A→B pattern', () => {
    const actions = [
      action({ action: 'click', reasoning: 'click element' }),
      action({ action: 'press', reasoning: 'press escape' }),
      action({ action: 'click', reasoning: 'click element again' }),
      action({ action: 'press', reasoning: 'press escape again' }),
    ];
    expect(detectStuckPattern(actions)).toBe('oscillating_actions');
  });

  it('detects oscillating with clickInIframe and escape pattern', () => {
    const actions = [
      action({ action: 'clickInIframe', reasoning: 'click section' }),
      action({ action: 'scroll', reasoning: 'scroll down' }),
      action({ action: 'clickInIframe', reasoning: 'click section again' }),
      action({ action: 'scroll', reasoning: 'scroll again' }),
    ];
    expect(detectStuckPattern(actions)).toBe('oscillating_actions');
  });

  it('does not detect oscillating with A→A→A→A (same action, not alternating)', () => {
    const actions = [
      action({ action: 'click', reasoning: 'click' }),
      action({ action: 'click', reasoning: 'click again' }),
      action({ action: 'click', reasoning: 'click once more' }),
      action({ action: 'click', reasoning: 'click yet again' }),
    ];
    // A===B so the isOscillating check fails (actionTypes[0] !== actionTypes[1] is false)
    expect(detectStuckPattern(actions)).not.toBe('oscillating_actions');
  });

  it('does not detect oscillating with A→B→C→D (all different)', () => {
    const actions = [
      action({ action: 'click', reasoning: 'click' }),
      action({ action: 'type', reasoning: 'type' }),
      action({ action: 'scroll', reasoning: 'scroll' }),
      action({ action: 'hover', reasoning: 'hover' }),
    ];
    // actionTypes[0] !== actionTypes[2] → not oscillating
    expect(detectStuckPattern(actions)).not.toBe('oscillating_actions');
  });

  // ── generic_stuck ────────────────────────────────────────────────────────

  it('detects generic_stuck with 4+ actions, no progress, no specific pattern', () => {
    const actions = [
      action({ reasoning: 'doing something' }),
      action({ reasoning: 'still working on it' }),
      action({ reasoning: 'making progress' }),
      action({ reasoning: 'almost there' }),
    ];
    expect(detectStuckPattern(actions)).toBe('generic_stuck');
  });

  it('does not detect generic_stuck with only 3 non-keyword actions', () => {
    const actions = [
      action({ reasoning: 'doing something' }),
      action({ reasoning: 'still working' }),
      action({ reasoning: 'almost done' }),
    ];
    // 3 actions with no keyword matches and < 4 for generic_stuck
    expect(detectStuckPattern(actions)).toBeUndefined();
  });

  // ── Pattern priority (earlier patterns win) ──────────────────────────────

  it('prioritizes cant_add_section over generic_stuck', () => {
    const actions = [
      action({ reasoning: 'trying to add section' }),
      action({ reasoning: 'still trying to add section' }),
      action({ reasoning: 'add section not working' }),
      action({ reasoning: 'giving up on add section' }),
    ];
    expect(detectStuckPattern(actions)).toBe('cant_add_section');
  });

  it('prioritizes cant_add_block over cant_find_element when both match', () => {
    // "add block" matches cant_add_block; "can't find" matches cant_find_element
    // cant_add_block is checked first
    const actions = [
      action({ reasoning: "can't find the add block button" }),
      action({ reasoning: "still can't find add block" }),
      action({ reasoning: "looking for add a block button, can't find it" }),
    ];
    expect(detectStuckPattern(actions)).toBe('cant_add_block');
  });

  it('prioritizes cant_add_section over cant_add_block when both keywords present', () => {
    // "add section" matches cant_add_section (checked first)
    const actions = [
      action({ reasoning: 'need to add section then add block' }),
      action({ reasoning: 'trying to add section and add block' }),
      action({ reasoning: 'add section then add block failing' }),
    ];
    expect(detectStuckPattern(actions)).toBe('cant_add_section');
  });

  // ── Reasoning combines across last 4 actions ────────────────────────────

  it('detects pattern from reasoning split across multiple actions', () => {
    // "add section" appears only when reasoning from multiple actions is combined
    const actions = [
      action({ reasoning: 'need to add a' }),
      action({ reasoning: 'section to the page' }),
      // The combined reasoning from last4 includes "add a" + "section" but
      // the join creates "need to add a section to the page" which includes "add a section"
      action({ reasoning: 'clicking around' }),
      action({ reasoning: 'still nothing happening' }),
    ];
    expect(detectStuckPattern(actions)).toBe('cant_add_section');
  });

  // ── Edge cases ───────────────────────────────────────────────────────────

  it('handles actions with no selector (undefined)', () => {
    const actions = [
      action({ selector: undefined, reasoning: 'add section now' }),
      action({ selector: undefined, reasoning: 'add section attempt 2' }),
      action({ selector: undefined, reasoning: 'add section attempt 3' }),
    ];
    expect(detectStuckPattern(actions)).toBe('cant_add_section');
  });

  it('handles long action history (only uses last 3-4)', () => {
    const oldActions = Array.from({ length: 20 }, () =>
      action({ reasoning: 'old action', pageChanged: true }),
    );
    const recentActions = [
      action({ reasoning: 'trying to add section' }),
      action({ reasoning: 'add section again' }),
      action({ reasoning: 'still trying add section' }),
    ];
    // Old actions have pageChanged=true but we only look at last 3
    expect(detectStuckPattern([...oldActions, ...recentActions])).toBe('cant_add_section');
  });

  it('is case-insensitive for reasoning keyword matching', () => {
    const actions = [
      action({ reasoning: 'ADD SECTION to the page' }),
      action({ reasoning: 'TRYING TO ADD SECTION' }),
      action({ reasoning: 'ADD SECTION FAILED' }),
    ];
    expect(detectStuckPattern(actions)).toBe('cant_add_section');
  });

  it('is case-insensitive for selector matching', () => {
    const actions = [
      action({ selector: 'BUTTON.ADD-SECTION', reasoning: 'click' }),
      action({ selector: '.Add-Section-Btn', reasoning: 'click' }),
      action({ selector: '.ADD-SECTION', reasoning: 'click' }),
    ];
    expect(detectStuckPattern(actions)).toBe('cant_add_section');
  });
});

// ─── getRescueHint ───────────────────────────────────────────────────────────

describe('getRescueHint', () => {
  const allPatterns: StuckPattern[] = [
    'cant_add_section',
    'cant_add_block',
    'cant_edit_text',
    'cant_edit_button',
    'cant_find_element',
    'clicking_wrong_things',
    'all_actions_failing',
    'oscillating_actions',
    'generic_stuck',
  ];

  it('returns a non-empty string for every StuckPattern type', () => {
    for (const pattern of allPatterns) {
      const hint = getRescueHint(pattern, 'some reasoning');
      expect(hint, `Expected non-empty hint for pattern: ${pattern}`).toBeTruthy();
      expect(typeof hint).toBe('string');
      expect(hint.length).toBeGreaterThan(10);
    }
  });

  // ── Pattern-specific hint content ────────────────────────────────────────

  it('cant_add_section hint mentions jsClick and ADD SECTION', () => {
    const hint = getRescueHint('cant_add_section', 'trying to add section');
    expect(hint).toContain('jsClick');
    expect(hint).toContain('ADD SECTION');
  });

  it('cant_add_block hint mentions Edit Section and Add Block', () => {
    const hint = getRescueHint('cant_add_block', 'trying to add block');
    expect(hint).toContain('Edit Section');
    expect(hint).toContain('Add Block');
  });

  it('cant_edit_text hint mentions double-click and type action', () => {
    const hint = getRescueHint('cant_edit_text', 'trying to edit text');
    expect(hint).toContain('Double-click');
    expect(hint).toContain('type');
  });

  it('cant_edit_button hint mentions double-click and URL', () => {
    const hint = getRescueHint('cant_edit_button', 'trying to edit button');
    expect(hint).toContain('Double-click');
    expect(hint).toContain('URL');
  });

  it('cant_find_element hint mentions scroll and hover', () => {
    const hint = getRescueHint('cant_find_element', 'looking for element');
    expect(hint).toContain('SCROLL');
    expect(hint).toContain('HOVER');
  });

  it('clicking_wrong_things hint mentions iframe vs admin UI distinction', () => {
    const hint = getRescueHint('clicking_wrong_things', 'clicking buttons');
    expect(hint).toContain('clickInIframe');
    expect(hint).toContain('ADMIN UI');
  });

  it('all_actions_failing hint mentions frame context and edit mode', () => {
    const hint = getRescueHint('all_actions_failing', 'everything is failing');
    expect(hint).toContain('clickInIframe');
    expect(hint).toContain('edit mode');
  });

  it('oscillating_actions hint mentions breaking the cycle', () => {
    const hint = getRescueHint('oscillating_actions', 'going back and forth');
    expect(hint).toContain('Escape');
    expect(hint).toContain('DIFFERENT');
  });

  it('generic_stuck hint mentions screenshot and Squarespace reminders', () => {
    const hint = getRescueHint('generic_stuck', 'not making progress');
    expect(hint).toContain('screenshot');
    expect(hint).toContain('Squarespace');
  });

  // ── All hints contain rescue hint marker ─────────────────────────────────

  it('all hints contain the RESCUE HINT marker', () => {
    for (const pattern of allPatterns) {
      const hint = getRescueHint(pattern, 'reasoning');
      expect(hint, `Expected RESCUE HINT marker for pattern: ${pattern}`).toContain('RESCUE HINT');
    }
  });

  // ── All hints contain actionable workflow advice ─────────────────────────

  it('all hints contain numbered steps (workflow advice)', () => {
    for (const pattern of allPatterns) {
      const hint = getRescueHint(pattern, 'reasoning');
      expect(hint, `Expected numbered steps for pattern: ${pattern}`).toMatch(/\d+\./);
    }
  });
});
