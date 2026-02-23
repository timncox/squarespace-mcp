/**
 * Seed learnings from this development session into the database.
 * These patterns were discovered through debugging and will be
 * surfaced to the browser agent via buildLearnedPatternsSection().
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });
import { upsertLearning } from '../src/db/learnings.js';

const learnings = [
  // ── Positive patterns (DO) ──
  {
    category: 'editor_workflow' as const,
    patternKey: 'addImageBlock-exits-edit-mode',
    description: 'After addImageBlock completes (step 7: Escape + click outside), the section is no longer in Fluid Engine edit mode. You must call enterSectionEditMode again before adding more blocks.',
    promptTip: 'After addImageBlock, always call enterSectionEditMode before addBlockToSection or editButtonBlock — addImageBlock exits edit mode when it closes.',
    confidence: 0.95,
    polarity: 'positive' as const,
  },
  {
    category: 'interaction_pattern' as const,
    patternKey: 'section-scroll-before-click',
    description: 'When entering section edit mode, the section must be scrolled into the viewport first. Use scrollIntoViewIfNeeded() before getting boundingBox() coordinates, otherwise the coordinates may be off-screen and clicks go to the wrong place.',
    promptTip: 'Always scroll a section into view (scrollIntoViewIfNeeded) before clicking to enter edit mode. Off-screen sections return incorrect bounding box coordinates.',
    confidence: 0.9,
    polarity: 'positive' as const,
  },
  {
    category: 'workflow_sequence' as const,
    patternKey: 'multi-block-section-workflow',
    description: 'To add multiple blocks (image + text + button) to a single section: addSection → enterSectionEditMode → addImageBlock → [re-enter edit mode] → addBlockToSection(Text) → [re-enter edit mode] → addBlockToSection(Button) → [re-enter edit mode] → editButtonBlock. Must re-enter edit mode between each block.',
    promptTip: 'When adding multiple blocks to one section, re-enter edit mode (enterSectionEditMode) between EACH block addition. The sequence is: addSection → enter → addBlock → re-enter → addBlock → re-enter → addBlock.',
    confidence: 0.95,
    polarity: 'positive' as const,
  },
  {
    category: 'interaction_pattern' as const,
    patternKey: 'createPage-inline-title',
    description: 'After clicking [data-test="blank-page-option"] (Page), Squarespace auto-focuses an <input type="text"> with the value "New Page". Type the title immediately using Cmd+A → type → Enter. Do NOT navigate away before typing — navigation cancels the creation.',
    promptTip: 'When creating a page: after clicking "Page", immediately type the title in the auto-focused input (Cmd+A → type → Enter). Do NOT navigate away — it cancels page creation.',
    confidence: 1.0,
    polarity: 'positive' as const,
  },
  {
    category: 'selector_discovery' as const,
    patternKey: 'deletePage-inline-icon',
    description: 'To delete a page in the Pages panel, hover over the page item to reveal action icons, then click [data-test="delete-item"]. Use Y-proximity matching to find the delete icon on the correct row. Confirm in the dialog that appears.',
    promptTip: 'Delete pages using the inline [data-test="delete-item"] icon that appears on hover, NOT through page settings. Use Y-proximity to match the correct row.',
    confidence: 1.0,
    polarity: 'positive' as const,
  },
  {
    category: 'interaction_pattern' as const,
    patternKey: 'enter-edit-mode-double-click',
    description: 'To enter section edit mode after scrolling a section into view: get the section boundingBox(), compute the click target (center X, limited Y), then double-click with page.mouse.dblclick(cx, cy). This is more reliable than clickThroughOverlay for re-entering edit mode.',
    promptTip: 'To re-enter section edit mode: scroll section into view → get boundingBox → double-click at section center. Double-click via page.mouse.dblclick() is more reliable than clickThroughOverlay.',
    confidence: 0.85,
    polarity: 'positive' as const,
  },

  // ── Negative patterns (AVOID) ──
  {
    category: 'negative_pattern' as const,
    patternKey: 'avoid-footer-section-content',
    description: 'The footer section (typically the last section, often with class/id containing "footer") appears on EVERY page of the site. Never add project-specific content (images, text, buttons) to the footer section. Always verify the target section is not the footer before adding blocks.',
    promptTip: 'NEVER add content to the footer section — it shows on every page. Verify the target section is not the footer (check class/id for "footer") before adding blocks.',
    confidence: 1.0,
    polarity: 'negative' as const,
  },
  {
    category: 'negative_pattern' as const,
    patternKey: 'avoid-navigate-after-page-create',
    description: 'After clicking "Page" in the add page sub-menu, an inline title input is auto-focused. Navigating away (e.g., to /config/pages) before typing the title and pressing Enter cancels the page creation entirely.',
    promptTip: 'DO NOT navigate away after clicking "Page" in the add sub-menu. The inline title input must be filled and confirmed with Enter first, or page creation is cancelled.',
    confidence: 1.0,
    polarity: 'negative' as const,
  },
  {
    category: 'negative_pattern' as const,
    patternKey: 'avoid-settings-panel-delete',
    description: 'Do not try to delete pages via the settings panel (gear icon → looking for delete button). The Delete button is hard to find in settings. Use the inline [data-test="delete-item"] icon on hover instead.',
    promptTip: 'DO NOT try to delete pages via the settings panel/gear icon. Use the inline hover delete icon [data-test="delete-item"] instead.',
    confidence: 0.9,
    polarity: 'negative' as const,
  },
];

console.log('Seeding learnings...\n');
for (const l of learnings) {
  const result = upsertLearning(l);
  console.log(`  ${result.polarity === 'negative' ? '🚫' : '✅'} ${result.patternKey} (confidence: ${result.confidence})`);
}
console.log(`\nDone! ${learnings.length} learnings seeded.`);
