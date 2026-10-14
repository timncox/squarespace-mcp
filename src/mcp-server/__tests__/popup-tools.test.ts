import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const mockClient = {
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getPopupSummary: vi.fn(),
  savePopupSlices: vi.fn(),
  getGalleryItems: vi.fn(),
  addGalleryImageViaSaveMedia: vi.fn(),
  removeGalleryImage: vi.fn(),
};

vi.mock('../session.js', () => ({
  getClient: vi.fn(() => mockClient),
}));

import { registerPopupTools, bodyTextToHtml, bodyHtmlToText } from '../tools/popup.js';

function createMockServer() {
  const tools = new Map<string, { config: any; handler: Function }>();
  return {
    registerTool: vi.fn((name: string, config: any, handler: Function) => {
      tools.set(name, { config, handler });
    }),
    tools,
    callTool: async (name: string, params: any) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} not registered`);
      return tool.handler(params);
    },
  };
}

// Shapes as returned by bmco on 2026-10-13
const SETTINGS = {
  popupOverlaySettings: {
    style: 2, showOnScroll: true, scrollPercentage: 25, showOnTimer: true, timerDelay: 5000,
    showUntilSignup: true, displayFrequency: 30, enableMobile: true, enabledPages: [], showOnAllPages: true, version: 1,
  },
  announcementBarSettings: {},
};

const SLICES = [
  { id: 'g1', slideId: 'slide1', type: 5, content: { _type: 'Gallery', source: 1, contentCollectionId: 'coll1', disableImages: false } },
  { id: 'h1', slideId: 'slide1', type: 1, content: { _type: 'Heading', text: '' } },
  { id: 'b1', slideId: 'slide1', type: 3, content: { _type: 'Body', body: { html: '<p data-rte-preserve-empty="true" style="white-space:pre-wrap;">‍</p><p></p>', raw: false } } },
  {
    id: 'a1', slideId: 'slide1', type: 20,
    content: {
      _type: 'PopupOverlayAction', acceptedTypes: [8, 11], currentType: 8,
      currentContent: {
        _type: 'Buttons', limit: 2,
        links: [{ text: 'Reserve on Resy', clickthroughUrl: { url: 'https://resy.com/x', newWindow: false } }],
      },
    },
  },
];

function summary() {
  return { success: true, slide: { id: 'slide1', layoutIdentifier: 'overlay-center-card-05' }, slices: structuredClone(SLICES), tweakValues: {} };
}

describe('Popup Tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerPopupTools(server as any);
    mockClient.getSettings.mockResolvedValue({ success: true, data: structuredClone(SETTINGS) });
    mockClient.updateSettings.mockResolvedValue({ success: true, updatedFields: ['popupOverlaySettings'] });
    mockClient.getPopupSummary.mockResolvedValue(summary());
    mockClient.savePopupSlices.mockResolvedValue({ success: true, savedCount: 1 });
    mockClient.getGalleryItems.mockResolvedValue({ success: true, items: [{ id: 'img-old', filename: 'old.jpg', assetUrl: 'https://img/old.jpg' }] });
    mockClient.addGalleryImageViaSaveMedia.mockResolvedValue({ success: true, itemId: 'img-new' });
    mockClient.removeGalleryImage.mockResolvedValue({ success: true });
  });

  it('registers both tools', () => {
    expect(server.tools.has('sq_get_popup')).toBe(true);
    expect(server.tools.has('sq_update_popup')).toBe(true);
  });

  describe('body text helpers', () => {
    it('round-trips multi-line text', () => {
      const html = bodyTextToHtml('Thursday, Nov 26\n$145 <per> guest & more');
      expect(html).toBe('<p style="white-space:pre-wrap;">Thursday, Nov 26</p><p style="white-space:pre-wrap;">$145 &lt;per&gt; guest &amp; more</p>');
      expect(bodyHtmlToText(html)).toBe('Thursday, Nov 26\n$145 <per> guest & more');
    });

    it('treats the editor empty-paragraph placeholder as empty', () => {
      expect(bodyHtmlToText(SLICES[2].content.body!.html)).toBe('');
    });
  });

  describe('sq_get_popup', () => {
    it('normalizes settings, content and images', async () => {
      const result = await server.callTool('sq_get_popup', { siteId: 'bmco' });
      const data = JSON.parse(result.content[0].text);
      expect(data).toMatchObject({
        enabled: true, showOnAllPages: true, enableMobile: true, timerDelaySeconds: 5,
        scrollPercentage: 25, displayFrequencyDays: 30, slideId: 'slide1', layout: 'overlay-center-card-05',
        heading: '', body: '', imageCollectionId: 'coll1', actionType: 'Buttons',
        buttons: [{ text: 'Reserve on Resy', url: 'https://resy.com/x', newWindow: false }],
      });
      expect(data.images).toEqual([{ itemId: 'img-old', filename: 'old.jpg', url: 'https://img/old.jpg' }]);
    });

    it('reports off when style is 1', async () => {
      mockClient.getSettings.mockResolvedValue({ success: true, data: { popupOverlaySettings: { ...SETTINGS.popupOverlaySettings, style: 1 } } });
      const data = JSON.parse((await server.callTool('sq_get_popup', { siteId: 'bmco' })).content[0].text);
      expect(data.enabled).toBe(false);
    });

    it('surfaces a missing pop-up', async () => {
      mockClient.getPopupSummary.mockResolvedValue({ success: false, error: 'No pop-up has been set up on this site yet' });
      const result = await server.callTool('sq_get_popup', { siteId: 'bmco' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No pop-up');
    });
  });

  describe('sq_update_popup', () => {
    it('turns the pop-up off without touching other settings or content', async () => {
      const result = await server.callTool('sq_update_popup', { siteId: 'bmco', enabled: false });
      expect(result.isError).toBeUndefined();
      expect(mockClient.updateSettings).toHaveBeenCalledWith({
        popupOverlaySettings: { ...SETTINGS.popupOverlaySettings, style: 1 },
      });
      expect(mockClient.getPopupSummary).not.toHaveBeenCalled();
      expect(mockClient.savePopupSlices).not.toHaveBeenCalled();
    });

    it('converts seconds to ms and days to displayFrequency', async () => {
      await server.callTool('sq_update_popup', { siteId: 'bmco', timerDelaySeconds: 2.5, displayFrequencyDays: 60, enableMobile: false });
      const sent = mockClient.updateSettings.mock.calls[0][0].popupOverlaySettings;
      expect(sent.timerDelay).toBe(2500);
      expect(sent.displayFrequency).toBe(60);
      expect(sent.enableMobile).toBe(false);
      expect(sent.style).toBe(2);
    });

    it('upserts only the changed slices, keeping their ids', async () => {
      await server.callTool('sq_update_popup', {
        siteId: 'bmco',
        heading: 'Thanksgiving Feast',
        buttons: [{ text: 'View the Menu', url: '/menu' }, { text: 'Reserve', url: 'https://resy.com/x', newWindow: true }],
      });
      const [slideId, slices] = mockClient.savePopupSlices.mock.calls[0];
      expect(slideId).toBe('slide1');
      expect(slices.map((s: any) => s.id)).toEqual(['h1', 'a1']);
      expect(slices[0].content).toEqual({ _type: 'Heading', text: 'Thanksgiving Feast' });
      expect(slices[1].content.currentContent.links).toEqual([
        { text: 'View the Menu', clickthroughUrl: { url: '/menu', newWindow: false } },
        { text: 'Reserve', clickthroughUrl: { url: 'https://resy.com/x', newWindow: true } },
      ]);
      expect(slices[1].content.currentContent.limit).toBe(2);
      expect(mockClient.updateSettings).not.toHaveBeenCalled();
    });

    it('refuses buttons when the action is a newsletter form', async () => {
      const s = summary();
      (s.slices[3].content as any).currentContent = { _type: 'Newsletter' };
      mockClient.getPopupSummary.mockResolvedValue(s);
      const result = await server.callTool('sq_update_popup', { siteId: 'bmco', buttons: [] });
      expect(result.isError).toBe(true);
      expect(mockClient.savePopupSlices).not.toHaveBeenCalled();
    });

    it('adds the new image before removing the old one', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'popup-test-'));
      const path = join(dir, 'feast.jpg');
      writeFileSync(path, Buffer.from([0xff, 0xd8, 0xff]));

      const result = await server.callTool('sq_update_popup', { siteId: 'bmco', imagePath: path });
      expect(result.isError).toBeUndefined();
      expect(mockClient.addGalleryImageViaSaveMedia).toHaveBeenCalledWith('coll1', expect.any(Buffer), 'feast.jpg', 'image/jpeg');
      expect(mockClient.removeGalleryImage).toHaveBeenCalledWith('coll1', 'img-old');
      const addOrder = mockClient.addGalleryImageViaSaveMedia.mock.invocationCallOrder[0];
      const removeOrder = mockClient.removeGalleryImage.mock.invocationCallOrder[0];
      expect(addOrder).toBeLessThan(removeOrder);
    });

    it('keeps the old image when the upload fails', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'popup-test-'));
      const path = join(dir, 'feast.png');
      writeFileSync(path, Buffer.from([0x89, 0x50]));
      mockClient.addGalleryImageViaSaveMedia.mockResolvedValue({ success: false, error: '500' });

      const result = await server.callTool('sq_update_popup', { siteId: 'bmco', imagePath: path });
      expect(result.isError).toBe(true);
      expect(mockClient.removeGalleryImage).not.toHaveBeenCalled();
    });

    it('rejects unsupported image types before writing anything', async () => {
      const result = await server.callTool('sq_update_popup', { siteId: 'bmco', imagePath: '/tmp/menu.pdf', enabled: false });
      expect(result.isError).toBe(true);
      expect(mockClient.updateSettings).not.toHaveBeenCalled();
      expect(mockClient.getPopupSummary).not.toHaveBeenCalled();
    });

    it('errors when nothing is passed', async () => {
      const result = await server.callTool('sq_update_popup', { siteId: 'bmco' });
      expect(result.isError).toBe(true);
    });
  });
});
