import { ContentSaveClient } from './client.js';
import type {
  GridCoord,
  MobileVisibilityResult,
  MobileLayoutSetResult,
  MobileMoveResult,
  MobileResizeResult,
} from './types.js';
import { logger } from '../../utils/logger.js';
import { errMsg } from '../../utils/errors.js';

declare module './index.js' {
  interface ContentSaveClient {
    hideOnMobile(
      pageSectionsId: string,
      collectionId: string,
      searchText: string,
    ): Promise<MobileVisibilityResult>;
    showOnMobile(
      pageSectionsId: string,
      collectionId: string,
      searchText: string,
    ): Promise<MobileVisibilityResult>;
    setMobileLayout(
      pageSectionsId: string,
      collectionId: string,
      searchText: string,
      layout: { start?: GridCoord; end?: GridCoord; visible?: boolean },
    ): Promise<MobileLayoutSetResult>;
    moveBlockMobile(
      pageSectionsId: string,
      collectionId: string,
      searchText: string,
      direction: 'up' | 'down' | 'left' | 'right',
      gridSteps?: number,
    ): Promise<MobileMoveResult>;
    resizeBlockMobile(
      pageSectionsId: string,
      collectionId: string,
      searchText: string,
      width?: 'smaller' | 'larger' | 'full',
      height?: 'shorter' | 'taller',
    ): Promise<MobileResizeResult>;
  }
}

// ── hideOnMobile ────────────────────────────────────────────────────────────

ContentSaveClient.prototype.hideOnMobile = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
): Promise<MobileVisibilityResult> {
  try {
    const data = await this.getPageSections(pageSectionsId);

    const match = this.findBlock(data.sections, searchText);
    if (!match) {
      return { success: false, error: `No block found matching "${searchText}"` };
    }

    const { gridContent } = match;
    const layout = gridContent.layout;
    if (!layout?.mobile) {
      return { success: false, error: `Block "${searchText}" has no mobile layout` };
    }

    layout.mobile.visible = false;
    const blockId = gridContent.content.value.id;

    logger.info({ blockId }, 'Hiding block on mobile via Content Save API');

    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId, visible: false };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

// ── showOnMobile ────────────────────────────────────────────────────────────

ContentSaveClient.prototype.showOnMobile = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
): Promise<MobileVisibilityResult> {
  try {
    const data = await this.getPageSections(pageSectionsId);

    const match = this.findBlock(data.sections, searchText);
    if (!match) {
      return { success: false, error: `No block found matching "${searchText}"` };
    }

    const { gridContent } = match;
    const layout = gridContent.layout;
    if (!layout?.mobile) {
      return { success: false, error: `Block "${searchText}" has no mobile layout` };
    }

    layout.mobile.visible = true;
    const blockId = gridContent.content.value.id;

    logger.info({ blockId }, 'Showing block on mobile via Content Save API');

    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId, visible: true };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

// ── setMobileLayout ─────────────────────────────────────────────────────────

ContentSaveClient.prototype.setMobileLayout = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  layout: { start?: GridCoord; end?: GridCoord; visible?: boolean },
): Promise<MobileLayoutSetResult> {
  try {
    const data = await this.getPageSections(pageSectionsId);

    const match = this.findBlock(data.sections, searchText);
    if (!match) {
      return { success: false, error: `No block found matching "${searchText}"` };
    }

    const { gridContent, gridSettings } = match;
    const blockLayout = gridContent.layout;
    if (!blockLayout?.mobile) {
      return { success: false, error: `Block "${searchText}" has no mobile layout` };
    }

    const mobile = blockLayout.mobile;
    const blockId = gridContent.content.value.id;
    const mobileColumns = gridSettings?.breakpointSettings?.mobile?.columns ?? 8;

    const oldLayout = {
      start: { ...mobile.start },
      end: { ...mobile.end },
      visible: mobile.visible,
    };

    // Apply only the provided fields
    if (layout.start !== undefined) mobile.start = { ...layout.start };
    if (layout.end !== undefined) mobile.end = { ...layout.end };
    if (layout.visible !== undefined) mobile.visible = layout.visible;

    // Validate dimensions
    if (mobile.end.x <= mobile.start.x) {
      return { success: false, error: 'Invalid layout: end.x must be greater than start.x' };
    }
    if (mobile.end.y <= mobile.start.y) {
      return { success: false, error: 'Invalid layout: end.y must be greater than start.y' };
    }

    let clamped = false;

    // Clamp X: shift entire block if out of bounds
    if (mobile.start.x < 1) {
      const shift = 1 - mobile.start.x;
      mobile.start.x += shift;
      mobile.end.x += shift;
      clamped = true;
    }
    if (mobile.end.x > mobileColumns + 1) {
      const shift = mobile.end.x - (mobileColumns + 1);
      mobile.start.x -= shift;
      mobile.end.x -= shift;
      clamped = true;
    }

    // Clamp Y: shift block down if top goes negative
    if (mobile.start.y < 0) {
      const shift = -mobile.start.y;
      mobile.start.y += shift;
      mobile.end.y += shift;
      clamped = true;
    }

    const newLayout = {
      start: { ...mobile.start },
      end: { ...mobile.end },
      visible: mobile.visible,
    };

    logger.info(
      { blockId, layout, clamped, oldLayout, newLayout },
      'Setting mobile layout via Content Save API',
    );

    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId, oldLayout, newLayout, clamped };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

// ── moveBlockMobile ─────────────────────────────────────────────────────────

ContentSaveClient.prototype.moveBlockMobile = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  direction: 'up' | 'down' | 'left' | 'right',
  gridSteps?: number,
): Promise<MobileMoveResult> {
  try {
    const data = await this.getPageSections(pageSectionsId);

    const match = this.findBlock(data.sections, searchText);
    if (!match) {
      return { success: false, error: `No block found matching "${searchText}"` };
    }

    const { gridContent, gridSettings } = match;
    const layout = gridContent.layout;
    if (!layout?.mobile) {
      return { success: false, error: `Block "${searchText}" has no mobile layout` };
    }

    const mobile = layout.mobile;
    const blockId = gridContent.content.value.id;
    const mobileColumns = gridSettings?.breakpointSettings?.mobile?.columns ?? 8;

    const oldPosition = {
      mobile: { start: { ...mobile.start }, end: { ...mobile.end } },
    };

    const blockWidth = mobile.end.x - mobile.start.x;
    const blockHeight = mobile.end.y - mobile.start.y;
    const step = gridSteps ?? (direction === 'left' || direction === 'right' ? blockWidth : blockHeight);

    switch (direction) {
      case 'left':
        mobile.start.x -= step;
        mobile.end.x -= step;
        break;
      case 'right':
        mobile.start.x += step;
        mobile.end.x += step;
        break;
      case 'up':
        mobile.start.y -= step;
        mobile.end.y -= step;
        break;
      case 'down':
        mobile.start.y += step;
        mobile.end.y += step;
        break;
    }

    let clamped = false;

    if (mobile.start.x < 1) {
      const shift = 1 - mobile.start.x;
      mobile.start.x += shift;
      mobile.end.x += shift;
      clamped = true;
    }
    if (mobile.end.x > mobileColumns + 1) {
      const shift = mobile.end.x - (mobileColumns + 1);
      mobile.start.x -= shift;
      mobile.end.x -= shift;
      clamped = true;
    }
    if (mobile.start.y < 0) {
      const shift = -mobile.start.y;
      mobile.start.y += shift;
      mobile.end.y += shift;
      clamped = true;
    }

    const newPosition = {
      mobile: { start: { ...mobile.start }, end: { ...mobile.end } },
    };

    logger.info(
      { blockId, direction, step, clamped, oldPosition, newPosition },
      'Moving block on mobile via Content Save API',
    );

    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId, direction, oldPosition, newPosition, clamped };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

// ── resizeBlockMobile ───────────────────────────────────────────────────────

ContentSaveClient.prototype.resizeBlockMobile = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  width?: 'smaller' | 'larger' | 'full',
  height?: 'shorter' | 'taller',
): Promise<MobileResizeResult> {
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
    if (!layout?.mobile) {
      return { success: false, error: `Block "${searchText}" has no mobile layout` };
    }

    const mobile = layout.mobile;
    const blockId = gridContent.content.value.id;
    const mobileColumns = gridSettings?.breakpointSettings?.mobile?.columns ?? 8;

    const oldWidth = mobile.end.x - mobile.start.x;
    const oldHeight = mobile.end.y - mobile.start.y;
    const oldSize = {
      width: oldWidth, height: oldHeight,
      mobile: { start: { ...mobile.start }, end: { ...mobile.end } },
    };

    let clamped = false;

    if (width === 'full') {
      mobile.start.x = 1;
      mobile.end.x = mobileColumns + 1;
    } else if (width === 'larger') {
      mobile.end.x += 2;
    } else if (width === 'smaller') {
      mobile.end.x -= 2;
    }

    if (height === 'taller') {
      mobile.end.y += 1;
    } else if (height === 'shorter') {
      mobile.end.y -= 1;
    }

    // Enforce minimum size: 1 col wide, 1 row tall
    if (mobile.end.x <= mobile.start.x) {
      mobile.end.x = mobile.start.x + 1;
      clamped = true;
    }
    if (mobile.end.y <= mobile.start.y) {
      mobile.end.y = mobile.start.y + 1;
      clamped = true;
    }

    // Clamp right edge to mobile grid boundary
    if (mobile.end.x > mobileColumns + 1) {
      mobile.end.x = mobileColumns + 1;
      clamped = true;
    }

    const newWidth = mobile.end.x - mobile.start.x;
    const newHeight = mobile.end.y - mobile.start.y;
    const newSize = {
      width: newWidth, height: newHeight,
      mobile: { start: { ...mobile.start }, end: { ...mobile.end } },
    };

    logger.info(
      { blockId, width, height, clamped, oldSize: { w: oldWidth, h: oldHeight }, newSize: { w: newWidth, h: newHeight } },
      'Resizing block on mobile via Content Save API',
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
