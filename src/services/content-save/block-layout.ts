import { ContentSaveClient } from './client.js';
import type {
  BlockMoveResult,
  BlockResizeResult,
  BlockRemoveResult,
  BlockRemoveOptions,
  BlockDuplicateResult,
  GridCoord,
  GridContent,
} from './types.js';
import { logger } from '../../utils/logger.js';
import { errMsg } from '../../utils/errors.js';

// ── Declaration merging ─────────────────────────────────────────────────────

declare module './index.js' {
  interface ContentSaveClient {
    moveBlock(
      pageSectionsId: string,
      collectionId: string,
      searchText: string,
      direction: 'up' | 'down' | 'left' | 'right',
      gridSteps?: number,
    ): Promise<BlockMoveResult>;
    swapBlocks(
      pageSectionsId: string,
      collectionId: string,
      searchText1: string,
      searchText2: string,
    ): Promise<BlockMoveResult>;
    resizeBlock(
      pageSectionsId: string,
      collectionId: string,
      searchText: string,
      width?: 'smaller' | 'larger' | 'full',
      height?: 'shorter' | 'taller',
    ): Promise<BlockResizeResult>;
    setBlockPosition(
      pageSectionsId: string,
      collectionId: string,
      searchText: string,
      position: { start: GridCoord; end: GridCoord },
    ): Promise<BlockMoveResult>;
    setBlockSize(
      pageSectionsId: string,
      collectionId: string,
      searchText: string,
      size: { width?: number; height?: number },
    ): Promise<BlockResizeResult>;
    removeBlock(
      pageSectionsId: string,
      collectionId: string,
      searchText: string,
      options?: BlockRemoveOptions,
    ): Promise<BlockRemoveResult>;
    duplicateBlock(
      pageSectionsId: string,
      collectionId: string,
      searchText: string,
    ): Promise<BlockDuplicateResult>;
  }
}

// ── Prototype methods ───────────────────────────────────────────────────────

ContentSaveClient.prototype.moveBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  direction: 'up' | 'down' | 'left' | 'right',
  gridSteps?: number,
): Promise<BlockMoveResult> {
  try {
    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);

    // Step 2: Find the block
    const match = this.findBlock(data.sections, searchText);
    if (!match) {
      return { success: false, error: `No block found matching "${searchText}"` };
    }

    const { gridContent, gridSettings } = match;
    const layout = gridContent.layout;
    if (!layout?.desktop) {
      return { success: false, error: `Block "${searchText}" has no desktop layout` };
    }

    const desktop = layout.desktop;
    const blockId = gridContent.content.value.id;
    const maxColumns = gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

    // Save old position
    const oldPosition = {
      desktop: { start: { ...desktop.start }, end: { ...desktop.end } },
    };

    // Calculate block dimensions
    const blockWidth = desktop.end.x - desktop.start.x;
    const blockHeight = desktop.end.y - desktop.start.y;

    // Default step = block's own dimension in the movement direction
    const step = gridSteps ?? (direction === 'left' || direction === 'right' ? blockWidth : blockHeight);

    // Step 3: Shift coordinates
    switch (direction) {
      case 'left':
        desktop.start.x -= step;
        desktop.end.x -= step;
        break;
      case 'right':
        desktop.start.x += step;
        desktop.end.x += step;
        break;
      case 'up':
        desktop.start.y -= step;
        desktop.end.y -= step;
        break;
      case 'down':
        desktop.start.y += step;
        desktop.end.y += step;
        break;
    }

    // Step 4: Clamp to boundaries
    let clamped = false;

    // X boundaries: [1, maxColumns]
    if (desktop.start.x < 1) {
      const shift = 1 - desktop.start.x;
      desktop.start.x += shift;
      desktop.end.x += shift;
      clamped = true;
    }
    if (desktop.end.x > maxColumns + 1) {
      const shift = desktop.end.x - (maxColumns + 1);
      desktop.start.x -= shift;
      desktop.end.x -= shift;
      clamped = true;
    }

    // Y boundary: >= 0 (no upper limit on rows)
    if (desktop.start.y < 0) {
      const shift = -desktop.start.y;
      desktop.start.y += shift;
      desktop.end.y += shift;
      clamped = true;
    }

    const newPosition = {
      desktop: { start: { ...desktop.start }, end: { ...desktop.end } },
    };

    logger.info(
      { blockId, direction, step, clamped, oldPosition, newPosition },
      'Moving block via Content Save API',
    );

    // Step 5: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId, direction, oldPosition, newPosition, clamped };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

/**
 * Swap two blocks' positions by exchanging their full layout objects.
 * Single GET + PUT.
 */
ContentSaveClient.prototype.swapBlocks = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText1: string,
  searchText2: string,
): Promise<BlockMoveResult> {
  try {
    const data = await this.getPageSections(pageSectionsId);

    const match1 = this.findBlock(data.sections, searchText1);
    if (!match1) {
      return { success: false, error: `No block found matching "${searchText1}"` };
    }

    const match2 = this.findBlock(data.sections, searchText2);
    if (!match2) {
      return { success: false, error: `No block found matching "${searchText2}"` };
    }

    // Swap entire layout objects (desktop + mobile + zIndex)
    const tempLayout = match1.gridContent.layout;
    match1.gridContent.layout = match2.gridContent.layout;
    match2.gridContent.layout = tempLayout;

    const blockId1 = match1.gridContent.content.value.id;
    const blockId2 = match2.gridContent.content.value.id;

    logger.info({ blockId1, blockId2 }, 'Swapping block positions via Content Save API');

    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return {
      success: true,
      blockId: `${blockId1}<->${blockId2}`,
      direction: 'swap',
    };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

/**
 * Resize a block by adjusting its desktop grid end coordinates.
 * Read-modify-write: GET → findBlock → adjust end.x/end.y → clamp → PUT.
 *
 * Width: "smaller" shrinks by 2 cols, "larger" grows by 2, "full" spans all columns.
 * Height: "shorter" shrinks by 1 row, "taller" grows by 1 row.
 * Minimum size: 1 col wide, 1 row tall.
 * Desktop only — mobile auto-reflows.
 */
ContentSaveClient.prototype.resizeBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  width?: 'smaller' | 'larger' | 'full',
  height?: 'shorter' | 'taller',
): Promise<BlockResizeResult> {
  if (!width && !height) {
    return { success: false, error: 'Must provide at least width or height' };
  }

  try {
    const data = await this.getPageSections(pageSectionsId);

    const match = this.findBlock(data.sections, searchText);
    if (!match) {
      return { success: false, error: `No block found matching "${searchText}"` };
    }

    const { gridContent, gridSettings } = match;
    const layout = gridContent.layout;
    if (!layout?.desktop) {
      return { success: false, error: `Block "${searchText}" has no desktop layout` };
    }

    const desktop = layout.desktop;
    const blockId = gridContent.content.value.id;
    const maxColumns = gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

    const oldWidth = desktop.end.x - desktop.start.x;
    const oldHeight = desktop.end.y - desktop.start.y;
    const oldSize = {
      width: oldWidth, height: oldHeight,
      desktop: { start: { ...desktop.start }, end: { ...desktop.end } },
    };

    let clamped = false;

    // Adjust width
    if (width === 'full') {
      desktop.start.x = 1;
      desktop.end.x = maxColumns + 1;
    } else if (width === 'larger') {
      desktop.end.x += 2;
    } else if (width === 'smaller') {
      desktop.end.x -= 2;
    }

    // Adjust height
    if (height === 'taller') {
      desktop.end.y += 1;
    } else if (height === 'shorter') {
      desktop.end.y -= 1;
    }

    // Enforce minimum size: 1 col wide, 1 row tall
    if (desktop.end.x <= desktop.start.x) {
      desktop.end.x = desktop.start.x + 1;
      clamped = true;
    }
    if (desktop.end.y <= desktop.start.y) {
      desktop.end.y = desktop.start.y + 1;
      clamped = true;
    }

    // Clamp right edge to grid boundary
    if (desktop.end.x > maxColumns + 1) {
      desktop.end.x = maxColumns + 1;
      clamped = true;
    }

    const newWidth = desktop.end.x - desktop.start.x;
    const newHeight = desktop.end.y - desktop.start.y;
    const newSize = {
      width: newWidth, height: newHeight,
      desktop: { start: { ...desktop.start }, end: { ...desktop.end } },
    };

    logger.info(
      { blockId, width, height, clamped, oldSize: { w: oldWidth, h: oldHeight }, newSize: { w: newWidth, h: newHeight } },
      'Resizing block via Content Save API',
    );

    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId, oldSize, newSize, clamped };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

/**
 * Set a block's desktop position to exact grid coordinates.
 * Read-modify-write: GET → findBlock → set start/end → clamp → PUT.
 *
 * Clamping: start.x < 1 shifts the whole block right; end.x > maxColumns+1 shifts it left;
 * start.y < 0 shifts it down. Returns error if width or height is zero/negative.
 * Desktop only — mobile auto-reflows.
 */
ContentSaveClient.prototype.setBlockPosition = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  position: { start: GridCoord; end: GridCoord },
): Promise<BlockMoveResult> {
  const { start, end } = position;

  if (end.x <= start.x) {
    return { success: false, error: 'Invalid position: end.x must be greater than start.x (width must be > 0)' };
  }
  if (end.y <= start.y) {
    return { success: false, error: 'Invalid position: end.y must be greater than start.y (height must be > 0)' };
  }

  try {
    const data = await this.getPageSections(pageSectionsId);

    const match = this.findBlock(data.sections, searchText);
    if (!match) {
      return { success: false, error: `No block found matching "${searchText}"` };
    }

    const { gridContent, gridSettings } = match;
    const layout = gridContent.layout;
    if (!layout?.desktop) {
      return { success: false, error: `Block "${searchText}" has no desktop layout` };
    }

    const desktop = layout.desktop;
    const blockId = gridContent.content.value.id;
    const maxColumns = gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

    const oldPosition = {
      desktop: { start: { ...desktop.start }, end: { ...desktop.end } },
    };

    // Apply requested position
    desktop.start = { ...start };
    desktop.end = { ...end };

    let clamped = false;
    const blockWidth = desktop.end.x - desktop.start.x;
    const blockHeight = desktop.end.y - desktop.start.y;

    // Clamp X: shift entire block if it goes out of bounds
    if (desktop.start.x < 1) {
      const shift = 1 - desktop.start.x;
      desktop.start.x += shift;
      desktop.end.x += shift;
      clamped = true;
    }
    if (desktop.end.x > maxColumns + 1) {
      const shift = desktop.end.x - (maxColumns + 1);
      desktop.start.x -= shift;
      desktop.end.x -= shift;
      clamped = true;
    }

    // Clamp Y: shift block down if top goes negative
    if (desktop.start.y < 0) {
      const shift = -desktop.start.y;
      desktop.start.y += shift;
      desktop.end.y += shift;
      clamped = true;
    }

    const newPosition = {
      desktop: { start: { ...desktop.start }, end: { ...desktop.end } },
    };

    logger.info(
      { blockId, position, clamped, oldPosition, newPosition },
      'Setting block position via Content Save API',
    );

    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId, oldPosition, newPosition, clamped };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

/**
 * Set a block's desktop size to exact column width and/or row height.
 * Keeps start position fixed — only adjusts end.x and/or end.y.
 * Read-modify-write: GET → findBlock → set end → clamp → PUT.
 *
 * Omit width or height to leave that dimension unchanged.
 * end.x is clamped to maxColumns+1 if width would exceed the grid.
 * Desktop only — mobile auto-reflows.
 */
ContentSaveClient.prototype.setBlockSize = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  size: { width?: number; height?: number },
): Promise<BlockResizeResult> {
  const { width, height } = size;

  if (width === undefined && height === undefined) {
    return { success: false, error: 'Must provide at least width or height' };
  }
  if (width !== undefined && width <= 0) {
    return { success: false, error: 'Invalid size: width must be > 0' };
  }
  if (height !== undefined && height <= 0) {
    return { success: false, error: 'Invalid size: height must be > 0' };
  }

  try {
    const data = await this.getPageSections(pageSectionsId);

    const match = this.findBlock(data.sections, searchText);
    if (!match) {
      return { success: false, error: `No block found matching "${searchText}"` };
    }

    const { gridContent, gridSettings } = match;
    const layout = gridContent.layout;
    if (!layout?.desktop) {
      return { success: false, error: `Block "${searchText}" has no desktop layout` };
    }

    const desktop = layout.desktop;
    const blockId = gridContent.content.value.id;
    const maxColumns = gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

    const oldWidth = desktop.end.x - desktop.start.x;
    const oldHeight = desktop.end.y - desktop.start.y;
    const oldSize = {
      width: oldWidth, height: oldHeight,
      desktop: { start: { ...desktop.start }, end: { ...desktop.end } },
    };

    if (width !== undefined) desktop.end.x = desktop.start.x + width;
    if (height !== undefined) desktop.end.y = desktop.start.y + height;

    let clamped = false;
    if (desktop.end.x > maxColumns + 1) {
      desktop.end.x = maxColumns + 1;
      clamped = true;
    }

    const newWidth = desktop.end.x - desktop.start.x;
    const newHeight = desktop.end.y - desktop.start.y;
    const newSize = {
      width: newWidth, height: newHeight,
      desktop: { start: { ...desktop.start }, end: { ...desktop.end } },
    };

    logger.info(
      { blockId, size, clamped, oldSize: { w: oldWidth, h: oldHeight }, newSize: { w: newWidth, h: newHeight } },
      'Setting block size via Content Save API',
    );

    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId, oldSize, newSize, clamped };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.removeBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  options?: BlockRemoveOptions,
): Promise<BlockRemoveResult> {
  try {
    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);

    // Step 2: Find the block
    const match = this.findBlock(data.sections, searchText);
    if (!match) {
      return { success: false, error: `No block found matching "${searchText}"` };
    }

    const { section, blockIndex } = match;
    const blockId = match.gridContent.content.value.id;
    const blockType = match.gridContent.content.value.type;
    const sectionId = section.id;

    logger.info(
      { blockId, blockType, sectionId, blockIndex, searchText },
      'Removing block via Content Save API',
    );

    // Step 3: Splice the block out of gridContents
    section.fluidEngineContext!.gridContents.splice(blockIndex, 1);

    // Step 3b: Auto-shrink section to fit remaining content (free — same GET+PUT cycle)
    if (options?.shrinkSection !== false) {
      (section as Record<string, unknown>).sectionHeight = 'auto';
    }

    // Step 4: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId, blockType, sectionId };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.duplicateBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
): Promise<BlockDuplicateResult> {
  try {
    this.ensureCookies();

    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);

    // Step 2: Find the block
    const match = this.findBlock(data.sections, searchText);
    if (!match) {
      return { success: false, error: `No block found matching "${searchText}"` };
    }

    const { section, gridContent, sectionIndex } = match;
    const gridContents = section.fluidEngineContext?.gridContents;
    if (!gridContents) {
      return { success: false, error: 'Section has no gridContents' };
    }

    const originalBlockId = gridContent.content.value.id;

    // Step 2b: Backfill verticalAlignment and zIndex on existing blocks
    // Squarespace validates ALL blocks on PUT, so any block missing these fields will cause a 400 error.
    for (let i = 0; i < gridContents.length; i++) {
      const gc = gridContents[i];
      if (gc.layout?.desktop) {
        if (gc.layout.desktop.verticalAlignment == null) gc.layout.desktop.verticalAlignment = 'top';
        if (gc.layout.desktop.zIndex == null) gc.layout.desktop.zIndex = i;
      }
      if (gc.layout?.mobile) {
        if (gc.layout.mobile.verticalAlignment == null) gc.layout.mobile.verticalAlignment = 'top';
        if (gc.layout.mobile.zIndex == null) gc.layout.mobile.zIndex = i;
      }
    }

    // Step 3: Deep clone the block
    const cloned: GridContent = JSON.parse(JSON.stringify(gridContent));

    // Step 4: Generate new block ID
    const newBlockId = ContentSaveClient.generateBlockId();
    cloned.content.value.id = newBlockId;

    // Step 5: Position below original (same X, Y = original end Y + 2 gap rows)
    const GAP_ROWS = 2;
    if (cloned.layout?.desktop && gridContent.layout?.desktop) {
      const origDesktop = gridContent.layout.desktop;
      const height = origDesktop.end.y - origDesktop.start.y;
      const newStartY = origDesktop.end.y + GAP_ROWS;
      cloned.layout.desktop.start = { x: origDesktop.start.x, y: newStartY };
      cloned.layout.desktop.end = { x: origDesktop.end.x, y: newStartY + height };
      cloned.layout.desktop.zIndex = gridContents.length;
    }
    if (cloned.layout?.mobile && gridContent.layout?.mobile) {
      const origMobile = gridContent.layout.mobile;
      const height = origMobile.end.y - origMobile.start.y;
      const newStartY = origMobile.end.y + GAP_ROWS;
      cloned.layout.mobile.start = { x: origMobile.start.x, y: newStartY };
      cloned.layout.mobile.end = { x: origMobile.end.x, y: newStartY + height };
      cloned.layout.mobile.zIndex = gridContents.length;
    }

    // Step 6: Push to section
    gridContents.push(cloned);

    logger.info(
      { originalBlockId, newBlockId, sectionId: section.id, sectionIndex },
      'Duplicating block via Content Save API',
    );

    // Step 7: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return {
      success: true,
      originalBlockId,
      newBlockId,
      sectionId: section.id,
    };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};
