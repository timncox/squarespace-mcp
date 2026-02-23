// ─── Action Types ──────────────────────────────────────────────────────────

export type AgentAction =
  | { action: 'click'; selector?: string; x?: number; y?: number }
  | { action: 'dblclick'; selector?: string; x?: number; y?: number }
  | { action: 'hover'; selector?: string; x?: number; y?: number }
  | { action: 'type'; text: string }
  | { action: 'fill'; selector: string; value: string }
  | { action: 'press'; key: string }
  | { action: 'scroll'; direction: 'up' | 'down'; amount?: number }
  | { action: 'wait'; ms: number }
  | { action: 'navigate'; url: string }
  | { action: 'uploadFile'; selector: string; filePath: string }
  | { action: 'clickInIframe'; selector: string }
  | { action: 'dblclickInIframe'; selector: string }
  | { action: 'jsClick'; selector: string; frame?: 'main' | 'iframe' }
  | { action: 'findText'; text: string }
  | { action: 'saveChanges' }
  | { action: 'exitFooter' }
  | { action: 'editTextBlock'; searchText: string; newText: string }
  | { action: 'formatTextBlock'; searchText: string; formatLevel?: 'heading1' | 'heading2' | 'heading3' | 'heading4' | 'paragraph1' | 'paragraph2' | 'paragraph3' | 'monospace'; bold?: boolean; italic?: boolean; alignment?: 'left' | 'center' | 'right'; fontSize?: 'increase' | 'decrease' }
  | { action: 'editButtonBlock'; searchText: string; newLabel?: string; url?: string; size?: 'small' | 'medium' | 'large'; style?: 'primary' | 'secondary' | 'tertiary'; alignment?: 'left' | 'center' | 'right' }
  | { action: 'addBlockToSection'; blockType: string; content?: string }
  | { action: 'addSection'; template?: string; category?: string; templateIndex?: number }
  | { action: 'addSectionFromTemplate'; category: string; template: string; templateIndex?: number; replacements: {
      texts?: Array<{ searchText: string; newText: string }>;
      buttons?: Array<{ searchText: string; newLabel?: string; url?: string }>;
      images?: Array<{ searchText: string; imagePath: string; altText?: string }>;
      removeBlocks?: string[];
    }}
  | { action: 'enterSectionEditMode'; searchText?: string; sectionIndex?: 'last' | number }
  | { action: 'removeBlock'; searchText: string }
  | { action: 'moveSectionUp'; searchText: string }
  | { action: 'moveSectionDown'; searchText: string }
  | { action: 'replaceImage'; searchText: string; imagePath: string; altText?: string }
  | { action: 'addImageBlock'; imagePath: string; altText?: string }
  | { action: 'createPage'; title: string; slug?: string; template?: string }
  | { action: 'deletePage'; title: string }
  | { action: 'editSectionStyle'; searchText: string; backgroundColor?: string; backgroundImage?: string; sectionTheme?: string; sectionHeight?: 'auto' | 'small' | 'medium' | 'large' | 'full'; contentWidth?: 'inset' | 'full'; verticalAlignment?: 'top' | 'middle' | 'bottom'; overlayOpacity?: number; sectionPadding?: 'none' | 'small' | 'medium' | 'large'; blockSpacing?: 'none' | 'small' | 'medium' | 'large' }
  | { action: 'switchPage'; pageSlug: string }
  | { action: 'editPageSEO'; pageSlug: string; seoTitle?: string; seoDescription?: string }
  | { action: 'editCustomCSS'; css: string; mode: 'append' | 'replace' }
  | { action: 'createBlogPost'; blogPageSlug: string; title: string; content?: string; draft?: boolean }
  | { action: 'moveBlockInSection'; searchText: string; position: 'up' | 'down' | 'left' | 'right' }
  | { action: 'resizeBlock'; searchText: string; width?: 'smaller' | 'larger' | 'full'; height?: 'shorter' | 'taller' }
  | { action: 'editMenuBlock'; searchText: string; newContent: string }
  | { action: 'editQuoteBlock'; searchText: string; quote: string; attribution?: string }
  | { action: 'editCodeBlock'; searchText: string; code: string }
  | { action: 'done'; summary: string }
  | { action: 'error'; message: string };

export interface ActionResult {
  success: boolean;
  message: string;
}
