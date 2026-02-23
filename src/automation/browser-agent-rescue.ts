/**
 * Browser Agent Rescue System — detects when the agent is stuck and
 * provides targeted Squarespace editor advice to get it unstuck.
 *
 * Instead of a separate "helper agent" (expensive, slow), this module
 * pattern-matches recent actions to identify WHAT the agent is trying
 * to do and injects the relevant Squarespace workflow as a hint.
 *
 * Zero additional API calls — just smarter context at the right moment.
 */

import { logger } from '../utils/logger.js';
import { lookupSquarespaceDocs } from './squarespace-docs.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RecentAction {
  action: string;
  selector?: string;
  reasoning: string;
  success: boolean;
  pageChanged: boolean;
}

export type StuckPattern =
  | 'cant_add_section'
  | 'cant_add_block'
  | 'cant_edit_text'
  | 'cant_edit_button'
  | 'cant_find_element'
  | 'clicking_wrong_things'
  | 'all_actions_failing'
  | 'oscillating_actions'
  | 'generic_stuck';

// ─── Stuck Detection ────────────────────────────────────────────────────────

/**
 * Analyze recent actions to detect if the agent is stuck in a loop.
 * Returns the identified stuck pattern, or undefined if not stuck.
 *
 * A "stuck" state is detected when:
 * - 3+ consecutive actions have no page change
 * - Actions are repetitive (same action type or similar selectors)
 * - The agent's reasoning mentions the same struggle repeatedly
 */
export function detectStuckPattern(recentActions: RecentAction[]): StuckPattern | undefined {
  if (recentActions.length < 3) return undefined;

  const last3 = recentActions.slice(-3);
  const last4 = recentActions.slice(-4);

  // Check: no page changes in last 3 actions (basic stuck signal)
  const noRecentChanges = last3.every((a) => !a.pageChanged);
  if (!noRecentChanges) return undefined;

  // Check: repeated failures
  const recentFailures = last3.filter((a) => !a.success).length;
  const allRecentFailed = recentFailures >= 2;

  // Combine reasonings for keyword analysis
  const reasonings = last4.map((a) => a.reasoning.toLowerCase()).join(' ');
  const actions = last3.map((a) => a.action);
  const selectors = last3.map((a) => a.selector ?? '').join(' ').toLowerCase();

  // Pattern: trying to add a section
  if (
    reasonings.includes('add section') ||
    reasonings.includes('add a section') ||
    reasonings.includes('new section') ||
    selectors.includes('add-section') ||
    selectors.includes('addsection')
  ) {
    return 'cant_add_section';
  }

  // Pattern: trying to add a block
  if (
    reasonings.includes('add block') ||
    reasonings.includes('add a block') ||
    reasonings.includes('text block') ||
    reasonings.includes('button block') ||
    selectors.includes('add-block') ||
    selectors.includes('addblock')
  ) {
    return 'cant_add_block';
  }

  // Pattern: trying to edit text
  if (
    (reasonings.includes('type') || reasonings.includes('text') || reasonings.includes('heading')) &&
    (actions.includes('dblclickInIframe') || actions.includes('type') || actions.includes('dblclick'))
  ) {
    return 'cant_edit_text';
  }

  // Pattern: trying to edit a button
  if (
    reasonings.includes('button') &&
    (reasonings.includes('label') || reasonings.includes('url') || reasonings.includes('link'))
  ) {
    return 'cant_edit_button';
  }

  // Pattern: can't find an element
  if (
    reasonings.includes("can't find") ||
    reasonings.includes('cannot find') ||
    reasonings.includes('not visible') ||
    reasonings.includes("don't see") ||
    reasonings.includes('looking for')
  ) {
    return 'cant_find_element';
  }

  // Pattern: clicking lots of things but nothing's working
  if (allRecentFailed && actions.every((a) => a === 'click' || a === 'clickInIframe')) {
    return 'clicking_wrong_things';
  }

  // Pattern: ALL recent actions are failing (regardless of type)
  // More aggressive than clicking_wrong_things — covers fill failures, type failures, etc.
  if (recentActions.length >= 4) {
    const last4Actions = recentActions.slice(-4);
    const allFailing = last4Actions.every((a) => !a.success);
    if (allFailing) {
      return 'all_actions_failing';
    }
  }

  // Pattern: agent is oscillating between 2 actions (e.g., click → escape → click → escape)
  if (recentActions.length >= 4) {
    const last4Actions = recentActions.slice(-4);
    const actionTypes = last4Actions.map((a) => a.action);
    const isOscillating =
      actionTypes[0] === actionTypes[2] &&
      actionTypes[1] === actionTypes[3] &&
      actionTypes[0] !== actionTypes[1];
    if (isOscillating && noRecentChanges) {
      return 'oscillating_actions';
    }
  }

  // Generic stuck: no progress for 3+ actions
  if (noRecentChanges && recentActions.length >= 4) {
    return 'generic_stuck';
  }

  return undefined;
}

// ─── Rescue Hints ───────────────────────────────────────────────────────────

/**
 * Get a targeted rescue hint for the detected stuck pattern.
 * The hint is injected into the next step's task description to give
 * the agent specific Squarespace workflow advice.
 */
export function getRescueHint(pattern: StuckPattern, recentReasoning: string): string {
  const hints: Record<StuckPattern, string> = {

    cant_add_section: `
⚠️ RESCUE HINT — You seem stuck trying to add a section. The "ADD SECTION" button in Squarespace often doesn't respond to regular click/clickInIframe because of how the editor overlay handles events.

**TRY THIS FIRST — use jsClick (JavaScript-dispatched click):**
1. Use the "jsClick" action with selector "button" and scan for the ADD SECTION button text
2. Example: { "action": "jsClick", "selector": "button.sqs-add-section-button, button[class*='add-section'], button[class*='AddSection']" }
3. If that doesn't work, try: { "action": "jsClick", "selector": "button" } and look at the result — it will click the first button it finds

**On a BLANK page (no sections yet):**
1. Make sure you're in EDIT MODE first (SAVE/EXIT visible at top-left)
2. Try jsClick with various selectors for the ADD SECTION button
3. The button is inside the sqs-site-frame iframe

**On a page WITH existing sections:**
1. Hover BETWEEN two sections — a thin line with "Add Section" appears
2. Click "Add Section" — a panel opens on the LEFT
3. Click "+ Add Blank" then "Section"

**CRITICAL: If click and clickInIframe both fail, ALWAYS try jsClick before giving up.** The jsClick action dispatches JavaScript events directly on the DOM element, bypassing the overlay entirely.

**STOP trying the same click approach repeatedly.** If click/clickInIframe failed twice, switch to jsClick immediately.`,

    cant_add_block: `
⚠️ RESCUE HINT — You seem stuck trying to add a block. Follow this EXACT workflow:

1. First, make sure you're in a SECTION's edit mode:
   - Click on the section content (via clickInIframe) to select it
   - Click "Edit Section" (the pencil icon) on the section toolbar
2. Now look for **"Add Block"** — it's in the **TOP-LEFT corner** of the editor (NOT inline between blocks)
3. Click "Add Block" — a block picker panel opens
4. The picker has a **SEARCH BAR** — type "text" or "button" or "image" to find blocks quickly
5. Click the block type to add it to the section

**Common mistake:** Trying to click "Add Block" without being in section edit mode. You MUST click "Edit Section" (pencil icon) first. If you don't see a pencil icon, click on the section content first to select it.

**If you still can't find "Add Block":** Try scrolling up in the editor — the button may be above the visible area.`,

    cant_edit_text: `
⚠️ RESCUE HINT — You seem stuck trying to edit text. Follow this EXACT workflow:

1. **Double-click** the text block (use dblclickInIframe action) — this enters inline edit mode
2. A cursor appears in the text and a **floating toolbar** shows nearby
3. To type: use the "type" action with your text content
4. To make a heading: first type the text, then SELECT ALL the text (press Meta+a), then click the **"Format" dropdown** in the toolbar, then select H1, H2, H3, or H4
5. To add a new paragraph: press Enter, then type the next line
6. Click outside the text block when done — changes auto-save

**Common mistakes:**
- Trying to type without double-clicking the text block first
- Using "fill" instead of "type" — text blocks need "type" action
- Looking for a heading button instead of the Format dropdown
- If the toolbar seems collapsed, click the "…" (ellipsis) icon to expand it`,

    cant_edit_button: `
⚠️ RESCUE HINT — You seem stuck trying to edit a button. Follow this EXACT workflow:

1. **Double-click** the button block to open its editor panel
2. The editor has a **"Content" tab** — click it to see:
   - Button label text field (type your button text here)
   - URL/Link section — click the URL dropdown to set the link destination
3. To set an external URL: click the URL dropdown, select "External URL" or "Web Address", then paste the URL
4. Click outside the panel or click "Apply" to save

**If you can't click the button:** Make sure you're in edit mode. The button may be inside a section — try clicking the section first (clickInIframe), then look for the button block within the section edit view.`,

    cant_find_element: `
⚠️ RESCUE HINT — You can't find the element you're looking for. Try these approaches:

1. **SCROLL DOWN** — the element may be below the visible area. Use the "scroll" action.
2. **HOVER to reveal hidden controls** — Squarespace hides many buttons until hover. Hover over nearby elements.
3. **Take a screenshot and look carefully** — the element might have a different name or appearance than expected.
4. **Make sure you're on the right page** — check the page state to confirm you're on the correct page.
5. **Make sure you're in edit mode** — if you see a black "Edit" button at the top, you're in preview mode. Click "Edit" to enter edit mode.
6. **Check if a panel is blocking the view** — close any open editor panels (press Escape or click X) before looking for other elements.`,

    clicking_wrong_things: `
⚠️ RESCUE HINT — Your clicks aren't having the expected effect. STOP and re-assess:

1. **Check: Am I clicking ADMIN UI or PAGE CONTENT?**
   - Admin UI (toolbars, panels, buttons) → use regular "click" action
   - Page content (text, images, sections inside the iframe) → use "clickInIframe" action
   - The overlay intercepts all pointer events on page content — "click" won't work!

2. **Check: Am I in the right mode?**
   - To edit page content: must be in EDIT mode (click "Edit" button first)
   - To edit a section: must be in SECTION EDIT mode (click "Edit Section" pencil icon)
   - To edit a block: must DOUBLE-CLICK the block (not single-click)

3. **Try a completely different approach.** If clicking isn't working, try:
   - Using keyboard navigation (Tab, Enter, Escape)
   - Using a different selector
   - Hovering first to reveal hidden UI
   - Navigating to the correct page/section first`,

    all_actions_failing: `
⚠️ RESCUE HINT — Your last 4+ actions have ALL FAILED. Something fundamental is wrong with your approach.

**STOP and completely reassess.** Don't try variations of the same approach.

1. **Check your frame context.** The #1 cause of repeated failures is clicking page content with regular "click" when you need "clickInIframe", or vice versa:
   - Page elements (text, images, sections, buttons) → **clickInIframe** or **dblclickInIframe**
   - Admin UI (toolbars, panels, "Add Block", "Save", "Done") → regular **click**

2. **Check your edit mode.** You need to be in the right mode:
   - Page editing → "Edit" mode (SAVE/EXIT visible at top-left)
   - Section blocks → "Edit Section" mode (click pencil icon on section toolbar)
   - Text editing → Double-click the text block first

3. **Try a completely different approach.** If clicking fails, try:
   - **jsClick** — bypasses overlay event interception
   - **keyboard** — Tab through focusable elements, Enter to activate
   - **scroll** — target element may be off-screen

4. **Press Escape** to close any panels/dialogs that may be blocking interaction, then start fresh.`,

    oscillating_actions: `
⚠️ RESCUE HINT — You're stuck in a loop, alternating between the same two actions. This pattern will never make progress.

**Break the cycle immediately:**
1. Press **Escape** twice to fully clear any active mode/panel
2. Take a screenshot and carefully re-read the page state
3. Choose a COMPLETELY DIFFERENT action — not a variation of what you've been trying
4. If you're toggling between click and escape, the element you're clicking may be opening a panel that you immediately close. Instead:
   - Read the panel content before closing it — it may contain what you need
   - Or, try clicking a DIFFERENT element entirely
5. If nothing works, try scrolling to find the target element in a different location`,

    generic_stuck: `
⚠️ RESCUE HINT — You appear stuck (no visible progress in several steps).

**STOP and re-read the task.** Then:
1. Take a screenshot and describe EXACTLY what you see on the page
2. Identify what needs to happen NEXT (not the whole task — just the very next action)
3. Choose the simplest possible action to make progress
4. If you're unsure, try scrolling to see more of the page

**Key Squarespace reminders:**
- "Add Block" is in the TOP-LEFT corner (not inline between blocks)
- Block picker has a SEARCH BAR — type the block name
- Double-click to edit blocks, single-click to select sections
- Use clickInIframe for page content, regular click for admin UI
- Many controls are HIDDEN until you hover over them
- If the Format dropdown isn't visible in the text toolbar, click the "…" ellipsis icon`,
  };

  const hint = hints[pattern];
  if (hint) {
    logger.info({ pattern }, 'Rescue hint generated');
  }
  return hint;
}

// ─── Dynamic Escalation ──────────────────────────────────────────────────────

/**
 * Escalate to dynamic Squarespace doc lookup when static hints haven't worked.
 *
 * Called when:
 * - A rescue hint was already injected (static hint from getRescueHint)
 * - The agent is STILL stuck after 4+ steps with the static hint
 * - We need fresh, targeted advice from Squarespace's actual support docs
 *
 * This makes 2 HTTP fetches + 1 Haiku call (~$0.001). Only triggered on
 * escalation, not on every stuck detection.
 *
 * @param pattern — the stuck pattern that persists
 * @param recentReasoning — the agent's recent reasoning (what it's struggling with)
 * @returns A dynamic rescue hint from Squarespace docs, or undefined if lookup fails
 */
export async function escalateToDocLookup(
  pattern: StuckPattern,
  recentReasoning: string,
): Promise<string | undefined> {
  logger.info({ pattern }, 'Rescue escalation: static hints failed, looking up Squarespace docs');

  const dynamicHint = await lookupSquarespaceDocs(recentReasoning, pattern);

  if (dynamicHint) {
    logger.info(
      { pattern, hintLength: dynamicHint.length },
      'Rescue escalation: dynamic hint from Squarespace docs',
    );
    return dynamicHint;
  }

  logger.warn({ pattern }, 'Rescue escalation: dynamic lookup returned nothing');
  return undefined;
}
