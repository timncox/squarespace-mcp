import { describe, it, expect } from 'vitest';
import { parseAgentAction } from '../browser-agent-actions.js';

describe('parseAgentAction', () => {
  // ── Valid JSON actions ──────────────────────────────────────────────

  it('parses a simple click action', () => {
    const result = parseAgentAction('{"action":"click","selector":"button.submit"}');
    expect(result).toEqual({ action: 'click', selector: 'button.submit' });
  });

  it('parses a click with coordinates', () => {
    const result = parseAgentAction('{"action":"click","x":100,"y":200}');
    expect(result).toEqual({ action: 'click', x: 100, y: 200 });
  });

  it('parses editTextBlock', () => {
    const result = parseAgentAction('{"action":"editTextBlock","searchText":"Hello","newText":"World"}');
    expect(result).toEqual({ action: 'editTextBlock', searchText: 'Hello', newText: 'World' });
  });

  it('parses editButtonBlock with label only', () => {
    const result = parseAgentAction('{"action":"editButtonBlock","searchText":"Learn more","newLabel":"View Projects"}');
    expect(result).toEqual({ action: 'editButtonBlock', searchText: 'Learn more', newLabel: 'View Projects' });
  });

  it('parses editButtonBlock with URL only', () => {
    const result = parseAgentAction('{"action":"editButtonBlock","searchText":"Learn more","url":"/projects"}');
    expect(result).toEqual({ action: 'editButtonBlock', searchText: 'Learn more', url: '/projects' });
  });

  it('parses editButtonBlock with both label and URL', () => {
    const result = parseAgentAction(
      '{"action":"editButtonBlock","searchText":"Learn more","newLabel":"View Projects","url":"https://example.com/projects"}',
    );
    expect(result).toEqual({
      action: 'editButtonBlock',
      searchText: 'Learn more',
      newLabel: 'View Projects',
      url: 'https://example.com/projects',
    });
  });

  it('parses addBlockToSection', () => {
    const result = parseAgentAction('{"action":"addBlockToSection","blockType":"Text","content":"Hello World"}');
    expect(result).toEqual({ action: 'addBlockToSection', blockType: 'Text', content: 'Hello World' });
  });

  it('parses addSection with category and template', () => {
    const result = parseAgentAction('{"action":"addSection","category":"Gallery","template":"Grid"}');
    expect(result).toEqual({ action: 'addSection', category: 'Gallery', template: 'Grid' });
  });

  it('parses addSection with templateIndex', () => {
    const result = parseAgentAction('{"action":"addSection","category":"About","template":"Bio with Image","templateIndex":0}');
    expect(result).toEqual({ action: 'addSection', category: 'About', template: 'Bio with Image', templateIndex: 0 });
  });

  it('parses addSection with templateIndex only (no template name)', () => {
    const result = parseAgentAction('{"action":"addSection","category":"Intro","templateIndex":2}');
    expect(result).toEqual({ action: 'addSection', category: 'Intro', templateIndex: 2 });
  });

  it('parses enterSectionEditMode', () => {
    const result = parseAgentAction('{"action":"enterSectionEditMode","searchText":"Welcome"}');
    expect(result).toEqual({ action: 'enterSectionEditMode', searchText: 'Welcome' });
  });

  it('parses removeBlock', () => {
    const result = parseAgentAction('{"action":"removeBlock","searchText":"Old Content"}');
    expect(result).toEqual({ action: 'removeBlock', searchText: 'Old Content' });
  });

  it('parses done action', () => {
    const result = parseAgentAction('{"action":"done","summary":"All tasks completed."}');
    expect(result).toEqual({ action: 'done', summary: 'All tasks completed.' });
  });

  it('parses error action', () => {
    const result = parseAgentAction('{"action":"error","message":"Cannot find element."}');
    expect(result).toEqual({ action: 'error', message: 'Cannot find element.' });
  });

  it('parses type action', () => {
    const result = parseAgentAction('{"action":"type","text":"Hello World"}');
    expect(result).toEqual({ action: 'type', text: 'Hello World' });
  });

  it('parses fill action', () => {
    const result = parseAgentAction('{"action":"fill","selector":"input.name","value":"Tim"}');
    expect(result).toEqual({ action: 'fill', selector: 'input.name', value: 'Tim' });
  });

  it('parses press action', () => {
    const result = parseAgentAction('{"action":"press","key":"Enter"}');
    expect(result).toEqual({ action: 'press', key: 'Enter' });
  });

  it('parses scroll action', () => {
    const result = parseAgentAction('{"action":"scroll","direction":"down","amount":500}');
    expect(result).toEqual({ action: 'scroll', direction: 'down', amount: 500 });
  });

  it('parses navigate action', () => {
    const result = parseAgentAction('{"action":"navigate","url":"https://example.com"}');
    expect(result).toEqual({ action: 'navigate', url: 'https://example.com' });
  });

  it('parses saveChanges action', () => {
    const result = parseAgentAction('{"action":"saveChanges"}');
    expect(result).toEqual({ action: 'saveChanges' });
  });

  it('parses exitFooter action', () => {
    const result = parseAgentAction('{"action":"exitFooter"}');
    expect(result).toEqual({ action: 'exitFooter' });
  });

  it('parses moveSectionUp action', () => {
    const result = parseAgentAction('{"action":"moveSectionUp","searchText":"About Us"}');
    expect(result).toEqual({ action: 'moveSectionUp', searchText: 'About Us' });
  });

  it('parses moveSectionDown action', () => {
    const result = parseAgentAction('{"action":"moveSectionDown","searchText":"Contact"}');
    expect(result).toEqual({ action: 'moveSectionDown', searchText: 'Contact' });
  });

  it('parses replaceImage with all params', () => {
    const result = parseAgentAction(
      '{"action":"replaceImage","searchText":"Team photo","imagePath":"/tmp/photo.jpg","altText":"New team photo"}',
    );
    expect(result).toEqual({
      action: 'replaceImage',
      searchText: 'Team photo',
      imagePath: '/tmp/photo.jpg',
      altText: 'New team photo',
    });
  });

  it('parses replaceImage without altText', () => {
    const result = parseAgentAction(
      '{"action":"replaceImage","searchText":"Hero image","imagePath":"/tmp/hero.png"}',
    );
    expect(result).toEqual({
      action: 'replaceImage',
      searchText: 'Hero image',
      imagePath: '/tmp/hero.png',
    });
  });

  it('parses createPage with all params', () => {
    const result = parseAgentAction(
      '{"action":"createPage","title":"Portfolio","slug":"portfolio","template":"Gallery"}',
    );
    expect(result).toEqual({
      action: 'createPage',
      title: 'Portfolio',
      slug: 'portfolio',
      template: 'Gallery',
    });
  });

  it('parses createPage with title only', () => {
    const result = parseAgentAction('{"action":"createPage","title":"Blog"}');
    expect(result).toEqual({ action: 'createPage', title: 'Blog' });
  });

  it('parses editSectionStyle with backgroundColor', () => {
    const result = parseAgentAction(
      '{"action":"editSectionStyle","searchText":"Welcome","backgroundColor":"#FF5733"}',
    );
    expect(result).toEqual({
      action: 'editSectionStyle',
      searchText: 'Welcome',
      backgroundColor: '#FF5733',
    });
  });

  it('parses editSectionStyle with backgroundImage', () => {
    const result = parseAgentAction(
      '{"action":"editSectionStyle","searchText":"Hero","backgroundImage":"/tmp/bg.jpg"}',
    );
    expect(result).toEqual({
      action: 'editSectionStyle',
      searchText: 'Hero',
      backgroundImage: '/tmp/bg.jpg',
    });
  });

  it('parses editSectionStyle with both options', () => {
    const result = parseAgentAction(
      '{"action":"editSectionStyle","searchText":"Hero","backgroundColor":"#000000","backgroundImage":"/tmp/bg.jpg"}',
    );
    expect(result).toEqual({
      action: 'editSectionStyle',
      searchText: 'Hero',
      backgroundColor: '#000000',
      backgroundImage: '/tmp/bg.jpg',
    });
  });

  it('parses editSectionStyle with sectionTheme', () => {
    const result = parseAgentAction(
      '{"action":"editSectionStyle","searchText":"Hero","sectionTheme":"Dark"}',
    );
    expect(result).toEqual({
      action: 'editSectionStyle',
      searchText: 'Hero',
      sectionTheme: 'Dark',
    });
  });

  it('parses editSectionStyle with sectionHeight', () => {
    const result = parseAgentAction(
      '{"action":"editSectionStyle","searchText":"Hero","sectionHeight":"full"}',
    );
    expect(result).toEqual({
      action: 'editSectionStyle',
      searchText: 'Hero',
      sectionHeight: 'full',
    });
  });

  it('parses editSectionStyle with contentWidth and verticalAlignment', () => {
    const result = parseAgentAction(
      '{"action":"editSectionStyle","searchText":"About","contentWidth":"full","verticalAlignment":"middle"}',
    );
    expect(result).toEqual({
      action: 'editSectionStyle',
      searchText: 'About',
      contentWidth: 'full',
      verticalAlignment: 'middle',
    });
  });

  it('parses editSectionStyle with overlayOpacity', () => {
    const result = parseAgentAction(
      '{"action":"editSectionStyle","searchText":"Hero","backgroundImage":"/tmp/bg.jpg","overlayOpacity":50}',
    );
    expect(result).toEqual({
      action: 'editSectionStyle',
      searchText: 'Hero',
      backgroundImage: '/tmp/bg.jpg',
      overlayOpacity: 50,
    });
  });

  it('parses editSectionStyle with all properties', () => {
    const result = parseAgentAction(
      '{"action":"editSectionStyle","searchText":"Hero","sectionTheme":"Darkest","backgroundColor":"#1a1a2e","backgroundImage":"/tmp/bg.jpg","overlayOpacity":30,"sectionHeight":"large","contentWidth":"inset","verticalAlignment":"bottom"}',
    );
    expect(result).toEqual({
      action: 'editSectionStyle',
      searchText: 'Hero',
      sectionTheme: 'Darkest',
      backgroundColor: '#1a1a2e',
      backgroundImage: '/tmp/bg.jpg',
      overlayOpacity: 30,
      sectionHeight: 'large',
      contentWidth: 'inset',
      verticalAlignment: 'bottom',
    });
  });

  // ── Markdown code fences ───────────────────────────────────────────

  it('extracts JSON from markdown code fence', () => {
    const input = '```json\n{"action":"click","selector":"#btn"}\n```';
    const result = parseAgentAction(input);
    expect(result).toEqual({ action: 'click', selector: '#btn' });
  });

  it('extracts JSON from code fence without language tag', () => {
    const input = '```\n{"action":"press","key":"Escape"}\n```';
    const result = parseAgentAction(input);
    expect(result).toEqual({ action: 'press', key: 'Escape' });
  });

  it('extracts JSON embedded in surrounding text', () => {
    const input = 'I will click the button. {"action":"click","selector":"button"} That should work.';
    const result = parseAgentAction(input);
    expect(result).toEqual({ action: 'click', selector: 'button' });
  });

  it('handles reasoning field alongside action', () => {
    const input = '{"reasoning":"Need to click submit","action":"click","selector":".submit"}';
    const result = parseAgentAction(input);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('click');
  });

  // ── Edge cases & invalid inputs ────────────────────────────────────

  it('returns null for empty string', () => {
    expect(parseAgentAction('')).toBeNull();
  });

  it('returns null for plain text without JSON', () => {
    expect(parseAgentAction('This is just some text with no JSON')).toBeNull();
  });

  it('returns null for JSON without action field', () => {
    expect(parseAgentAction('{"selector":"button","value":"test"}')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseAgentAction('{"action": "click", selector: broken}')).toBeNull();
  });

  it('returns null for empty JSON object', () => {
    expect(parseAgentAction('{}')).toBeNull();
  });

  it('handles special characters in search text', () => {
    const result = parseAgentAction('{"action":"editTextBlock","searchText":"It\'s a \\"test\\"","newText":"Done"}');
    expect(result).not.toBeNull();
    expect(result!.action).toBe('editTextBlock');
  });

  it('handles multiline JSON in code fence', () => {
    const input = `\`\`\`json
{
  "reasoning": "I need to edit the text block",
  "action": "editTextBlock",
  "searchText": "Old text",
  "newText": "New text"
}
\`\`\``;
    const result = parseAgentAction(input);
    expect(result).toEqual({
      reasoning: 'I need to edit the text block',
      action: 'editTextBlock',
      searchText: 'Old text',
      newText: 'New text',
    });
  });

  // ── Wave 2: New compound action parsing ─────────────────────────────

  it('parses switchPage action', () => {
    const result = parseAgentAction('{"action":"switchPage","pageSlug":"about"}');
    expect(result).toEqual({ action: 'switchPage', pageSlug: 'about' });
  });

  it('parses editPageSEO with all params', () => {
    const result = parseAgentAction(
      '{"action":"editPageSEO","pageSlug":"contact","seoTitle":"Contact Us","seoDescription":"Get in touch"}',
    );
    expect(result).toEqual({
      action: 'editPageSEO',
      pageSlug: 'contact',
      seoTitle: 'Contact Us',
      seoDescription: 'Get in touch',
    });
  });

  it('parses editPageSEO with seoTitle only', () => {
    const result = parseAgentAction('{"action":"editPageSEO","pageSlug":"home","seoTitle":"Home | My Site"}');
    expect(result).toEqual({ action: 'editPageSEO', pageSlug: 'home', seoTitle: 'Home | My Site' });
  });

  it('parses editCustomCSS append mode', () => {
    const result = parseAgentAction('{"action":"editCustomCSS","css":"body { color: red; }","mode":"append"}');
    expect(result).toEqual({ action: 'editCustomCSS', css: 'body { color: red; }', mode: 'append' });
  });

  it('parses editCustomCSS replace mode', () => {
    const result = parseAgentAction('{"action":"editCustomCSS","css":"* { margin: 0; }","mode":"replace"}');
    expect(result).toEqual({ action: 'editCustomCSS', css: '* { margin: 0; }', mode: 'replace' });
  });

  it('parses createBlogPost with all params', () => {
    const result = parseAgentAction(
      '{"action":"createBlogPost","blogPageSlug":"blog","title":"My First Post","content":"Hello world","draft":false}',
    );
    expect(result).toEqual({
      action: 'createBlogPost',
      blogPageSlug: 'blog',
      title: 'My First Post',
      content: 'Hello world',
      draft: false,
    });
  });

  it('parses createBlogPost with minimal params', () => {
    const result = parseAgentAction('{"action":"createBlogPost","blogPageSlug":"news","title":"Breaking News"}');
    expect(result).toEqual({ action: 'createBlogPost', blogPageSlug: 'news', title: 'Breaking News' });
  });

  it('parses moveBlockInSection', () => {
    const result = parseAgentAction('{"action":"moveBlockInSection","searchText":"Welcome","position":"left"}');
    expect(result).toEqual({ action: 'moveBlockInSection', searchText: 'Welcome', position: 'left' });
  });

  it('parses resizeBlock with width only', () => {
    const result = parseAgentAction('{"action":"resizeBlock","searchText":"Hero Image","width":"full"}');
    expect(result).toEqual({ action: 'resizeBlock', searchText: 'Hero Image', width: 'full' });
  });

  it('parses resizeBlock with height only', () => {
    const result = parseAgentAction('{"action":"resizeBlock","searchText":"Sidebar","height":"taller"}');
    expect(result).toEqual({ action: 'resizeBlock', searchText: 'Sidebar', height: 'taller' });
  });

  it('parses resizeBlock with both width and height', () => {
    const result = parseAgentAction(
      '{"action":"resizeBlock","searchText":"Card","width":"larger","height":"shorter"}',
    );
    expect(result).toEqual({
      action: 'resizeBlock',
      searchText: 'Card',
      width: 'larger',
      height: 'shorter',
    });
  });

  it('parses editMenuBlock action', () => {
    const result = parseAgentAction(
      '{"action":"editMenuBlock","searchText":"Burger","newContent":"Burger $12\\nSalad $10\\nFish Tacos $14"}',
    );
    expect(result).toEqual({
      action: 'editMenuBlock',
      searchText: 'Burger',
      newContent: 'Burger $12\nSalad $10\nFish Tacos $14',
    });
  });

  it('parses editMenuBlock from markdown code fence', () => {
    const result = parseAgentAction(`\`\`\`json
{
  "reasoning": "I need to add Fish Tacos to the menu. The existing menu has Burger and Salad. I'll use editMenuBlock with the complete content.",
  "action": "editMenuBlock",
  "searchText": "Burger",
  "newContent": "Burger $12\\nSalad $10\\nFish Tacos $14"
}
\`\`\``);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('editMenuBlock');
    expect((result as any).searchText).toBe('Burger');
    expect((result as any).newContent).toBe('Burger $12\nSalad $10\nFish Tacos $14');
  });

  // ── addSectionFromTemplate tests ──────────────────────────────────

  it('parses addSectionFromTemplate with text replacements', () => {
    const result = parseAgentAction(JSON.stringify({
      action: 'addSectionFromTemplate',
      category: 'About',
      template: 'Bio with Image',
      replacements: {
        texts: [
          { searchText: 'About Us', newText: 'Meet Our Chef' },
          { searchText: 'Lorem ipsum', newText: 'Chef Maria brings 20 years of experience.' },
        ],
      },
    }));
    expect(result).not.toBeNull();
    expect(result!.action).toBe('addSectionFromTemplate');
    expect((result as any).category).toBe('About');
    expect((result as any).template).toBe('Bio with Image');
    expect((result as any).replacements.texts).toHaveLength(2);
    expect((result as any).replacements.texts[0].searchText).toBe('About Us');
    expect((result as any).replacements.texts[0].newText).toBe('Meet Our Chef');
  });

  it('parses addSectionFromTemplate with all replacement types', () => {
    const result = parseAgentAction(JSON.stringify({
      action: 'addSectionFromTemplate',
      category: 'About',
      template: 'Bio with Image',
      replacements: {
        texts: [{ searchText: 'About Us', newText: 'Our Team' }],
        buttons: [{ searchText: 'Learn More', newLabel: 'View Menu', url: '/menus' }],
        images: [{ searchText: 'placeholder', imagePath: '/tmp/photo.jpg', altText: 'Team photo' }],
        removeBlocks: ['Unwanted text'],
      },
    }));
    expect(result).not.toBeNull();
    expect(result!.action).toBe('addSectionFromTemplate');
    expect((result as any).replacements.texts).toHaveLength(1);
    expect((result as any).replacements.buttons).toHaveLength(1);
    expect((result as any).replacements.buttons[0].url).toBe('/menus');
    expect((result as any).replacements.images).toHaveLength(1);
    expect((result as any).replacements.images[0].imagePath).toBe('/tmp/photo.jpg');
    expect((result as any).replacements.removeBlocks).toHaveLength(1);
  });

  it('parses addSectionFromTemplate with empty replacements', () => {
    const result = parseAgentAction(JSON.stringify({
      action: 'addSectionFromTemplate',
      category: 'Intro',
      template: 'Centered Text',
      replacements: {},
    }));
    expect(result).not.toBeNull();
    expect(result!.action).toBe('addSectionFromTemplate');
    expect((result as any).category).toBe('Intro');
    expect((result as any).replacements).toEqual({});
  });

  it('parses addSectionFromTemplate with templateIndex', () => {
    const result = parseAgentAction(JSON.stringify({
      action: 'addSectionFromTemplate',
      category: 'About',
      template: 'Bio with Image',
      templateIndex: 0,
      replacements: {
        texts: [{ searchText: 'About Us', newText: 'Our Team' }],
      },
    }));
    expect(result).not.toBeNull();
    expect(result!.action).toBe('addSectionFromTemplate');
    expect((result as any).templateIndex).toBe(0);
    expect((result as any).category).toBe('About');
    expect((result as any).template).toBe('Bio with Image');
  });

  it('parses addSectionFromTemplate from markdown code fence', () => {
    const result = parseAgentAction(`\`\`\`json
{
  "reasoning": "Adding a bio section using the About template",
  "action": "addSectionFromTemplate",
  "category": "About",
  "template": "Bio with Image",
  "replacements": {
    "texts": [{"searchText": "About Us", "newText": "Our Story"}]
  }
}
\`\`\``);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('addSectionFromTemplate');
    expect((result as any).template).toBe('Bio with Image');
    expect((result as any).replacements.texts[0].newText).toBe('Our Story');
  });

  // ── editQuoteBlock + editCodeBlock + new block types tests ──────────

  it('parses editQuoteBlock with quote and attribution', () => {
    const result = parseAgentAction(
      '{"action":"editQuoteBlock","searchText":"Great food","quote":"An unforgettable dining experience.","attribution":"— James R."}',
    );
    expect(result).toEqual({
      action: 'editQuoteBlock',
      searchText: 'Great food',
      quote: 'An unforgettable dining experience.',
      attribution: '— James R.',
    });
  });

  it('parses editQuoteBlock with quote only (no attribution)', () => {
    const result = parseAgentAction(
      '{"action":"editQuoteBlock","searchText":"Old quote","quote":"New inspiring quote here"}',
    );
    expect(result).toEqual({
      action: 'editQuoteBlock',
      searchText: 'Old quote',
      quote: 'New inspiring quote here',
    });
  });

  it('parses editCodeBlock', () => {
    const result = parseAgentAction(
      '{"action":"editCodeBlock","searchText":"<iframe","code":"<div class=\\"map\\">New embed</div>"}',
    );
    expect(result).toEqual({
      action: 'editCodeBlock',
      searchText: '<iframe',
      code: '<div class="map">New embed</div>',
    });
  });

  it('parses addBlockToSection with blockType Quote and content', () => {
    const result = parseAgentAction(
      '{"action":"addBlockToSection","blockType":"Quote","content":"Life is what happens when you are busy making other plans."}',
    );
    expect(result).toEqual({
      action: 'addBlockToSection',
      blockType: 'Quote',
      content: 'Life is what happens when you are busy making other plans.',
    });
  });

  it('parses addBlockToSection with blockType Video and URL content', () => {
    const result = parseAgentAction(
      '{"action":"addBlockToSection","blockType":"Video","content":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}',
    );
    expect(result).toEqual({
      action: 'addBlockToSection',
      blockType: 'Video',
      content: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    });
  });

  // ── editSectionStyle padding + spacing tests ──────────────────────────

  it('parses editSectionStyle with sectionPadding only', () => {
    const result = parseAgentAction(
      '{"action":"editSectionStyle","searchText":"Hero","sectionPadding":"large"}',
    );
    expect(result).toEqual({
      action: 'editSectionStyle',
      searchText: 'Hero',
      sectionPadding: 'large',
    });
  });

  it('parses editSectionStyle with blockSpacing only', () => {
    const result = parseAgentAction(
      '{"action":"editSectionStyle","searchText":"About","blockSpacing":"small"}',
    );
    expect(result).toEqual({
      action: 'editSectionStyle',
      searchText: 'About',
      blockSpacing: 'small',
    });
  });

  it('parses editSectionStyle with both sectionPadding and blockSpacing', () => {
    const result = parseAgentAction(
      '{"action":"editSectionStyle","searchText":"Services","sectionPadding":"medium","blockSpacing":"large"}',
    );
    expect(result).toEqual({
      action: 'editSectionStyle',
      searchText: 'Services',
      sectionPadding: 'medium',
      blockSpacing: 'large',
    });
  });

  it('parses editSectionStyle with padding + other existing properties', () => {
    const result = parseAgentAction(
      '{"action":"editSectionStyle","searchText":"Hero","sectionTheme":"Dark","sectionHeight":"full","sectionPadding":"large","blockSpacing":"medium"}',
    );
    expect(result).toEqual({
      action: 'editSectionStyle',
      searchText: 'Hero',
      sectionTheme: 'Dark',
      sectionHeight: 'full',
      sectionPadding: 'large',
      blockSpacing: 'medium',
    });
  });

  // ── formatTextBlock tests ──────────────────────────────────────────────

  it('parses formatTextBlock with formatLevel only', () => {
    const result = parseAgentAction(
      '{"action":"formatTextBlock","searchText":"Welcome","formatLevel":"heading1"}',
    );
    expect(result).toEqual({
      action: 'formatTextBlock',
      searchText: 'Welcome',
      formatLevel: 'heading1',
    });
  });

  it('parses formatTextBlock with bold and italic', () => {
    const result = parseAgentAction(
      '{"action":"formatTextBlock","searchText":"Important","bold":true,"italic":true}',
    );
    expect(result).toEqual({
      action: 'formatTextBlock',
      searchText: 'Important',
      bold: true,
      italic: true,
    });
  });

  it('parses formatTextBlock with alignment only', () => {
    const result = parseAgentAction(
      '{"action":"formatTextBlock","searchText":"Title","alignment":"center"}',
    );
    expect(result).toEqual({
      action: 'formatTextBlock',
      searchText: 'Title',
      alignment: 'center',
    });
  });

  it('parses formatTextBlock with fontSize', () => {
    const result = parseAgentAction(
      '{"action":"formatTextBlock","searchText":"Subtitle","fontSize":"increase"}',
    );
    expect(result).toEqual({
      action: 'formatTextBlock',
      searchText: 'Subtitle',
      fontSize: 'increase',
    });
  });

  it('parses formatTextBlock with all params', () => {
    const result = parseAgentAction(
      '{"action":"formatTextBlock","searchText":"Title","formatLevel":"heading2","bold":true,"italic":false,"alignment":"right","fontSize":"decrease"}',
    );
    expect(result).toEqual({
      action: 'formatTextBlock',
      searchText: 'Title',
      formatLevel: 'heading2',
      bold: true,
      italic: false,
      alignment: 'right',
      fontSize: 'decrease',
    });
  });

  it('parses formatTextBlock with monospace format', () => {
    const result = parseAgentAction(
      '{"action":"formatTextBlock","searchText":"code example","formatLevel":"monospace"}',
    );
    expect(result).toEqual({
      action: 'formatTextBlock',
      searchText: 'code example',
      formatLevel: 'monospace',
    });
  });

  it('parses formatTextBlock with paragraph3 format', () => {
    const result = parseAgentAction(
      '{"action":"formatTextBlock","searchText":"Fine print","formatLevel":"paragraph3"}',
    );
    expect(result).toEqual({
      action: 'formatTextBlock',
      searchText: 'Fine print',
      formatLevel: 'paragraph3',
    });
  });

  it('parses formatTextBlock embedded in markdown', () => {
    const input = '```json\n{"action":"formatTextBlock","searchText":"Heading","formatLevel":"heading1","alignment":"center"}\n```';
    const result = parseAgentAction(input);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('formatTextBlock');
    expect((result as any).formatLevel).toBe('heading1');
  });

  // ── editButtonBlock Design tab tests ─────────────────────────────────

  it('parses editButtonBlock with size only', () => {
    const result = parseAgentAction(
      '{"action":"editButtonBlock","searchText":"Learn More","size":"large"}',
    );
    expect(result).toEqual({
      action: 'editButtonBlock',
      searchText: 'Learn More',
      size: 'large',
    });
  });

  it('parses editButtonBlock with style and alignment', () => {
    const result = parseAgentAction(
      '{"action":"editButtonBlock","searchText":"Get Started","style":"secondary","alignment":"center"}',
    );
    expect(result).toEqual({
      action: 'editButtonBlock',
      searchText: 'Get Started',
      style: 'secondary',
      alignment: 'center',
    });
  });

  it('parses editButtonBlock with all Content + Design params', () => {
    const result = parseAgentAction(
      '{"action":"editButtonBlock","searchText":"Book Now","newLabel":"Reserve","url":"/reservations","size":"large","style":"primary","alignment":"center"}',
    );
    expect(result).toEqual({
      action: 'editButtonBlock',
      searchText: 'Book Now',
      newLabel: 'Reserve',
      url: '/reservations',
      size: 'large',
      style: 'primary',
      alignment: 'center',
    });
  });

  it('parses editButtonBlock with size and style (no content params)', () => {
    const result = parseAgentAction(
      '{"action":"editButtonBlock","searchText":"Details","size":"small","style":"tertiary"}',
    );
    expect(result).toEqual({
      action: 'editButtonBlock',
      searchText: 'Details',
      size: 'small',
      style: 'tertiary',
    });
  });
});
