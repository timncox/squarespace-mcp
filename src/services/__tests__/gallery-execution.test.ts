import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ApiImageBlock,
  ApiGalleryBlock,
  ApiTextBlock,
  ApiButtonBlock,
} from '../../agents/types.js';
import {
  isApiImageBlock,
  isApiGalleryBlock,
  isApiButtonBlock,
} from '../../agents/types.js';

// ── Type Guard Tests ─────────────────────────────────────────────────────

describe('isApiImageBlock', () => {
  it('returns true for image blocks', () => {
    const block: ApiImageBlock = { type: 'image', imagePath: '/path/to/image.jpg' };
    expect(isApiImageBlock(block)).toBe(true);
  });

  it('returns false for text blocks', () => {
    const block: ApiTextBlock = { html: '<p>Hello</p>' };
    expect(isApiImageBlock(block)).toBe(false);
  });

  it('returns false for button blocks', () => {
    const block: ApiButtonBlock = { type: 'button', label: 'Click', url: '/link' };
    expect(isApiImageBlock(block)).toBe(false);
  });

  it('returns false for gallery blocks', () => {
    const block: ApiGalleryBlock = {
      type: 'gallery',
      images: [{ imagePath: '/path/to/img.jpg' }],
    };
    expect(isApiImageBlock(block)).toBe(false);
  });
});

describe('isApiGalleryBlock', () => {
  it('returns true for gallery blocks', () => {
    const block: ApiGalleryBlock = {
      type: 'gallery',
      images: [{ imagePath: '/path/to/img.jpg', altText: 'Test' }],
      galleryStyle: 'grid',
      columns: 3,
    };
    expect(isApiGalleryBlock(block)).toBe(true);
  });

  it('returns false for image blocks', () => {
    const block: ApiImageBlock = { type: 'image', imagePath: '/path/to/image.jpg' };
    expect(isApiGalleryBlock(block)).toBe(false);
  });

  it('returns false for text blocks', () => {
    const block: ApiTextBlock = { html: '<p>Hello</p>' };
    expect(isApiGalleryBlock(block)).toBe(false);
  });

  it('returns false for button blocks', () => {
    const block: ApiButtonBlock = { type: 'button', label: 'Click', url: '/link' };
    expect(isApiGalleryBlock(block)).toBe(false);
  });
});

// ── Gallery Layout Calculation Tests ─────────────────────────────────────

describe('gallery grid layout calculation', () => {
  // Replicate the layout calculation from executeGalleryBlock
  function calculateGalleryLayout(
    imageCount: number,
    columns: number,
  ): Array<{ startX: number; endX: number; startY: number; endY: number }> {
    const columnWidth = Math.floor(24 / columns);
    const rowHeight = 8;
    const gapRows = 2;
    const layouts: Array<{ startX: number; endX: number; startY: number; endY: number }> = [];

    for (let i = 0; i < imageCount; i++) {
      const col = i % columns;
      const row = Math.floor(i / columns);
      const startX = 1 + (col * columnWidth);
      const endX = Math.min(startX + columnWidth, 25);
      const startY = row * (rowHeight + gapRows);
      const endY = startY + rowHeight;
      layouts.push({ startX, endX, startY, endY });
    }

    return layouts;
  }

  it('calculates 2-column layout correctly', () => {
    const layouts = calculateGalleryLayout(4, 2);
    expect(layouts).toHaveLength(4);

    // 2 columns = 12 cols each
    // Row 0
    expect(layouts[0]).toEqual({ startX: 1, endX: 13, startY: 0, endY: 8 });
    expect(layouts[1]).toEqual({ startX: 13, endX: 25, startY: 0, endY: 8 });
    // Row 1
    expect(layouts[2]).toEqual({ startX: 1, endX: 13, startY: 10, endY: 18 });
    expect(layouts[3]).toEqual({ startX: 13, endX: 25, startY: 10, endY: 18 });
  });

  it('calculates 3-column layout correctly', () => {
    const layouts = calculateGalleryLayout(3, 3);
    expect(layouts).toHaveLength(3);

    // 3 columns = 8 cols each
    expect(layouts[0]).toEqual({ startX: 1, endX: 9, startY: 0, endY: 8 });
    expect(layouts[1]).toEqual({ startX: 9, endX: 17, startY: 0, endY: 8 });
    expect(layouts[2]).toEqual({ startX: 17, endX: 25, startY: 0, endY: 8 });
  });

  it('calculates 4-column layout correctly', () => {
    const layouts = calculateGalleryLayout(4, 4);
    expect(layouts).toHaveLength(4);

    // 4 columns = 6 cols each
    expect(layouts[0]).toEqual({ startX: 1, endX: 7, startY: 0, endY: 8 });
    expect(layouts[1]).toEqual({ startX: 7, endX: 13, startY: 0, endY: 8 });
    expect(layouts[2]).toEqual({ startX: 13, endX: 19, startY: 0, endY: 8 });
    expect(layouts[3]).toEqual({ startX: 19, endX: 25, startY: 0, endY: 8 });
  });

  it('wraps images to next row', () => {
    const layouts = calculateGalleryLayout(5, 3);
    expect(layouts).toHaveLength(5);

    // Row 0: 3 images
    expect(layouts[0].startY).toBe(0);
    expect(layouts[1].startY).toBe(0);
    expect(layouts[2].startY).toBe(0);

    // Row 1: 2 images
    expect(layouts[3].startY).toBe(10); // 8 (height) + 2 (gap)
    expect(layouts[4].startY).toBe(10);
  });

  it('handles single image', () => {
    const layouts = calculateGalleryLayout(1, 3);
    expect(layouts).toHaveLength(1);
    expect(layouts[0]).toEqual({ startX: 1, endX: 9, startY: 0, endY: 8 });
  });

  it('handles large gallery with many rows', () => {
    const layouts = calculateGalleryLayout(9, 3);
    expect(layouts).toHaveLength(9);

    // 3 rows of 3, each row at Y = 0, 10, 20
    expect(layouts[0].startY).toBe(0);
    expect(layouts[3].startY).toBe(10);
    expect(layouts[6].startY).toBe(20);
  });
});

// ── ApiBlock Type Compatibility Tests ────────────────────────────────────

describe('apiBlock type compatibility', () => {
  it('correctly identifies mixed apiBlocks array types', () => {
    const blocks: Array<ApiTextBlock | ApiButtonBlock | ApiImageBlock | ApiGalleryBlock> = [
      { html: '<h2>Portfolio</h2>' },
      { type: 'button', label: 'View All', url: '/portfolio' },
      { type: 'image', imagePath: '/path/to/hero.jpg', altText: 'Hero image' },
      {
        type: 'gallery',
        images: [
          { imagePath: '/path/to/img1.jpg', altText: 'Image 1' },
          { imagePath: '/path/to/img2.jpg', altText: 'Image 2' },
        ],
        galleryStyle: 'grid',
        columns: 2,
      },
    ];

    expect(isApiButtonBlock(blocks[0])).toBe(false);
    expect(isApiImageBlock(blocks[0])).toBe(false);
    expect(isApiGalleryBlock(blocks[0])).toBe(false);

    expect(isApiButtonBlock(blocks[1])).toBe(true);
    expect(isApiImageBlock(blocks[1])).toBe(false);
    expect(isApiGalleryBlock(blocks[1])).toBe(false);

    expect(isApiButtonBlock(blocks[2])).toBe(false);
    expect(isApiImageBlock(blocks[2])).toBe(true);
    expect(isApiGalleryBlock(blocks[2])).toBe(false);

    expect(isApiButtonBlock(blocks[3])).toBe(false);
    expect(isApiImageBlock(blocks[3])).toBe(false);
    expect(isApiGalleryBlock(blocks[3])).toBe(true);
  });
});

// ── ApiImageBlock Interface Tests ────────────────────────────────────────

describe('ApiImageBlock interface', () => {
  it('supports minimal image block', () => {
    const block: ApiImageBlock = {
      type: 'image',
      imagePath: '/path/to/photo.jpg',
    };
    expect(block.type).toBe('image');
    expect(block.imagePath).toBe('/path/to/photo.jpg');
    expect(block.altText).toBeUndefined();
    expect(block.title).toBeUndefined();
    expect(block.layout).toBeUndefined();
  });

  it('supports full image block with layout', () => {
    const block: ApiImageBlock = {
      type: 'image',
      imagePath: '/path/to/photo.jpg',
      altText: 'A beautiful sunset',
      title: 'Sunset',
      layout: {
        columns: 12,
        rowHeight: 8,
        gapRows: 2,
        startX: 1,
        endX: 13,
        startY: 0,
        endY: 8,
      },
    };
    expect(block.altText).toBe('A beautiful sunset');
    expect(block.layout?.columns).toBe(12);
    expect(block.layout?.startX).toBe(1);
  });
});

// ── ApiGalleryBlock Interface Tests ──────────────────────────────────────

describe('ApiGalleryBlock interface', () => {
  it('supports minimal gallery block', () => {
    const block: ApiGalleryBlock = {
      type: 'gallery',
      images: [{ imagePath: '/path/to/img.jpg' }],
    };
    expect(block.type).toBe('gallery');
    expect(block.images).toHaveLength(1);
    expect(block.galleryStyle).toBeUndefined();
    expect(block.columns).toBeUndefined();
  });

  it('supports full gallery block with options', () => {
    const block: ApiGalleryBlock = {
      type: 'gallery',
      images: [
        { imagePath: '/path/to/img1.jpg', altText: 'First', title: 'Image 1' },
        { imagePath: '/path/to/img2.jpg', altText: 'Second', title: 'Image 2' },
        { imagePath: '/path/to/img3.jpg', altText: 'Third', title: 'Image 3' },
      ],
      galleryStyle: 'grid',
      columns: 3,
    };
    expect(block.images).toHaveLength(3);
    expect(block.galleryStyle).toBe('grid');
    expect(block.columns).toBe(3);
    expect(block.images[1].altText).toBe('Second');
  });

  it('supports slideshow gallery style', () => {
    const block: ApiGalleryBlock = {
      type: 'gallery',
      images: [{ imagePath: '/img.jpg' }],
      galleryStyle: 'slideshow',
    };
    expect(block.galleryStyle).toBe('slideshow');
  });

  it('supports collage gallery style', () => {
    const block: ApiGalleryBlock = {
      type: 'gallery',
      images: [{ imagePath: '/img.jpg' }],
      galleryStyle: 'collage',
    };
    expect(block.galleryStyle).toBe('collage');
  });
});

// ── ContentSpec apiBlocks Union Type ─────────────────────────────────────

describe('ContentSpec apiBlocks union type', () => {
  it('accepts mixed block types in apiBlocks array', () => {
    // This test verifies the TypeScript union type works correctly
    const apiBlocks: Array<ApiTextBlock | ApiButtonBlock | ApiImageBlock | ApiGalleryBlock> = [
      { html: '<h2>Title</h2>', formatting: { tag: 'h2', alignment: 'center' } },
      { type: 'button', label: 'Learn More', url: '/about' },
      { type: 'image', imagePath: '/path/to/hero.png', altText: 'Hero' },
      {
        type: 'gallery',
        images: [
          { imagePath: '/img1.jpg', altText: 'Image 1' },
          { imagePath: '/img2.jpg', altText: 'Image 2' },
        ],
        columns: 2,
        galleryStyle: 'grid',
      },
    ];

    expect(apiBlocks).toHaveLength(4);

    // Verify type guards work on the array
    const textBlocks = apiBlocks.filter(b => !isApiButtonBlock(b) && !isApiImageBlock(b) && !isApiGalleryBlock(b));
    const buttonBlocks = apiBlocks.filter(isApiButtonBlock);
    const imageBlocks = apiBlocks.filter(isApiImageBlock);
    const galleryBlocks = apiBlocks.filter(isApiGalleryBlock);

    expect(textBlocks).toHaveLength(1);
    expect(buttonBlocks).toHaveLength(1);
    expect(imageBlocks).toHaveLength(1);
    expect(galleryBlocks).toHaveLength(1);
  });
});
