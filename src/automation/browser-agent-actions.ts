/**
 * Browser Agent Action Dispatcher
 *
 * Thin routing layer that maps AgentAction types to handler functions.
 * All handler implementations live in ./actions/ modules.
 *
 * Public API:
 *   - executeAgentAction(page, action) — run a single action
 *   - parseAgentAction(responseText)   — parse Claude's JSON response
 *   - AgentAction type                 — discriminated union of all actions
 *   - ActionResult interface           — { success, message }
 */

import { Page } from 'playwright';
import { logger } from '../utils/logger.js';
import { saveChanges } from './editor-actions.js';
import { errMsg } from '../utils/errors.js';

// ─── Re-export public API from actions modules ─────────────────────────────

export type { AgentAction, ActionResult } from './actions/types.js';
export { parseAgentAction } from './actions/parse-action.js';

// ─── Import types for this file ────────────────────────────────────────────

import type { AgentAction, ActionResult } from './actions/types.js';

// ─── Import all handlers ───────────────────────────────────────────────────

import {
  handleClick,
  handleDblclick,
  handleHover,
  handleClickInIframe,
  handleDblclickInIframe,
  handleJsClick,
  handleType,
  handleFill,
  handlePress,
  handleScroll,
  handleWait,
  handleNavigate,
  handleUploadFile,
  handleExitFooter,
  handleFindText,
} from './actions/basic-handlers.js';

import {
  handleEditTextBlock,
  handleFormatTextBlock,
  handleEditButtonBlock,
  handleEditMenuBlock,
  handleEditQuoteBlock,
  handleEditCodeBlock,
} from './actions/text-editing-handlers.js';

import {
  handleAddBlockToSection,
  handleRemoveBlock,
  handleMoveBlockInSection,
  handleResizeBlock,
} from './actions/block-management-handlers.js';

import {
  handleAddSection,
  handleAddSectionFromTemplate,
  handleEnterSectionEditMode,
  handleMoveSection,
  handleEditSectionStyle,
} from './actions/section-management-handlers.js';

import {
  handleReplaceImage,
  handleAddImageBlock,
} from './actions/image-handlers.js';

import {
  handleCreatePage,
  handleDeletePage,
  handleSwitchPage,
  handleEditPageSEO,
  handleEditCustomCSS,
  handleCreateBlogPost,
} from './actions/page-management-handlers.js';

// ─── Action Executor ───────────────────────────────────────────────────────

/**
 * Execute a single agent action on the page.
 * This is the main entry point called by the browser-agent loop.
 */
export async function executeAgentAction(
  page: Page,
  action: AgentAction,
): Promise<ActionResult> {
  logger.info({ action: action.action }, 'Executing agent action');

  try {
    switch (action.action) {
      case 'click':
        return await handleClick(page, action);

      case 'dblclick':
        return await handleDblclick(page, action);

      case 'hover':
        return await handleHover(page, action);

      case 'type':
        return await handleType(page, action);

      case 'fill':
        return await handleFill(page, action);

      case 'press':
        return await handlePress(page, action);

      case 'scroll':
        return await handleScroll(page, action);

      case 'wait':
        return await handleWait(page, action);

      case 'navigate':
        return await handleNavigate(page, action);

      case 'uploadFile':
        return await handleUploadFile(page, action);

      case 'clickInIframe':
        return await handleClickInIframe(page, action);

      case 'dblclickInIframe':
        return await handleDblclickInIframe(page, action);

      case 'jsClick':
        return await handleJsClick(page, action);

      case 'findText':
        return await handleFindText(page, action);

      case 'saveChanges':
        return await saveChanges(page);

      case 'exitFooter':
        return await handleExitFooter(page);

      case 'editTextBlock':
        return await handleEditTextBlock(page, action);

      case 'formatTextBlock':
        return await handleFormatTextBlock(page, action);

      case 'editButtonBlock':
        return await handleEditButtonBlock(page, action);

      case 'addBlockToSection':
        return await handleAddBlockToSection(page, action);

      case 'addSection':
        return await handleAddSection(page, action);

      case 'addSectionFromTemplate':
        return await handleAddSectionFromTemplate(page, action);

      case 'enterSectionEditMode':
        return await handleEnterSectionEditMode(page, action);

      case 'removeBlock':
        return await handleRemoveBlock(page, action);

      case 'moveSectionUp':
        return await handleMoveSection(page, action.searchText, 'up');

      case 'moveSectionDown':
        return await handleMoveSection(page, action.searchText, 'down');

      case 'replaceImage':
        return await handleReplaceImage(page, action);

      case 'addImageBlock':
        return await handleAddImageBlock(page, action);

      case 'createPage':
        return await handleCreatePage(page, action);

      case 'deletePage':
        return await handleDeletePage(page, action);

      case 'editSectionStyle':
        return await handleEditSectionStyle(page, action);

      case 'switchPage':
        return await handleSwitchPage(page, action);

      case 'editPageSEO':
        return await handleEditPageSEO(page, action);

      case 'editCustomCSS':
        return await handleEditCustomCSS(page, action);

      case 'createBlogPost':
        return await handleCreateBlogPost(page, action);

      case 'moveBlockInSection':
        return await handleMoveBlockInSection(page, action);

      case 'resizeBlock':
        return await handleResizeBlock(page, action);

      case 'editMenuBlock':
        return await handleEditMenuBlock(page, action);

      case 'editQuoteBlock':
        return await handleEditQuoteBlock(page, action);

      case 'editCodeBlock':
        return await handleEditCodeBlock(page, action);

      case 'done':
        return { success: true, message: `Done: ${action.summary}` };

      case 'error':
        return { success: false, message: `Agent error: ${action.message}` };

      default:
        return { success: false, message: `Unknown action: ${(action as Record<string, unknown>).action}` };
    }
  } catch (err) {
    const msg = errMsg(err);
    logger.error({ action: action.action, error: msg }, 'Agent action failed');
    return { success: false, message: `Action "${action.action}" threw: ${msg}` };
  }
}
