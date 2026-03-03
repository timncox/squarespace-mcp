import { describe, it, expect } from 'vitest';
import { formatOperationTypeReference } from '../content-strategist-agent.js';

// ── Tests for formatOperationTypeReference ──────────────────────────────────

describe('formatOperationTypeReference', () => {
  it('returns a string', () => {
    expect(typeof formatOperationTypeReference()).toBe('string');
  });

  it('contains all 20 operation type names', () => {
    const ref = formatOperationTypeReference();
    const opTypes = [
      'modify_text',
      'modify_block',
      'replace_image',
      'remove_block',
      'add_block',
      'add_gallery',
      'add_section',
      'modify_style',
      'reorder_sections',
      'move_block',
      'resize_block',
      'create_page',
      'delete_page',
      'update_page_metadata',
      'create_blog_post',
      'update_blog_post',
      'edit_footer',
      'edit_css',
      'edit_code_injection',
      'modify_gallery_settings',
    ];
    for (const opType of opTypes) {
      expect(ref).toContain(opType);
    }
  });

  it('contains decision guidance section', () => {
    const ref = formatOperationTypeReference();
    expect(ref).toContain('When to Use Each Operation Type');
  });

  it('contains blog collection ID guidance', () => {
    const ref = formatOperationTypeReference();
    expect(ref).toContain('blogCollectionId');
    expect(ref).toContain('collectionType');
  });

  it('contains required fields for each operation type', () => {
    const ref = formatOperationTypeReference();
    expect(ref).toContain('cssCode');
    expect(ref).toContain('codeInjectionHeader');
    expect(ref).toContain('blockDirection');
    expect(ref).toContain('sectionDirection');
  });

  it('distinguishes modify_text from add_section from add_block', () => {
    const ref = formatOperationTypeReference();
    expect(ref).toContain('Editing EXISTING text');
    expect(ref).toContain('Adding NEW section');
    expect(ref).toContain('Adding block to EXISTING section');
  });

  it('mentions modify_gallery_settings for gallery display changes', () => {
    const ref = formatOperationTypeReference();
    expect(ref).toContain('modify_gallery_settings');
  });

  it('includes table formatting with headers', () => {
    const ref = formatOperationTypeReference();
    expect(ref).toContain('| operationType |');
    expect(ref).toContain('| User Request |');
  });
});
