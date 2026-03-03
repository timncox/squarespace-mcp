import { describe, it, expect } from 'vitest';
import { applyFormattingToHtml } from '../actions/handler-utils.js';

const P = (text: string, style = 'white-space:pre-wrap;') =>
  `<p class="" style="${style}">${text}</p>`;
const H = (n: number, text: string) =>
  `<h${n} class="" style="white-space:pre-wrap;">${text}</h${n}>`;

describe('applyFormattingToHtml', () => {
  // ── heading conversion ────────────────────────────────────────────────

  it('converts <p> to <h2> for heading2', () => {
    expect(applyFormattingToHtml(P('Hello'), { formatLevel: 'heading2' }))
      .toBe(H(2, 'Hello'));
  });

  it('converts <p> to <h1> for heading1', () => {
    expect(applyFormattingToHtml(P('Title'), { formatLevel: 'heading1' }))
      .toBe(H(1, 'Title'));
  });

  it('converts <h3> to <h2>', () => {
    expect(applyFormattingToHtml(H(3, 'Old'), { formatLevel: 'heading2' }))
      .toBe(H(2, 'Old'));
  });

  it('converts each paragraph in a multi-paragraph block', () => {
    const html = P('First') + P('Second');
    expect(applyFormattingToHtml(html, { formatLevel: 'heading2' }))
      .toBe(H(2, 'First') + H(2, 'Second'));
  });

  // ── bold / italic ─────────────────────────────────────────────────────

  it('wraps content in <strong> when bold: true', () => {
    expect(applyFormattingToHtml(P('Hello'), { bold: true }))
      .toBe(P('<strong>Hello</strong>'));
  });

  it('wraps content in <em> when italic: true', () => {
    expect(applyFormattingToHtml(P('Hello'), { italic: true }))
      .toBe(P('<em>Hello</em>'));
  });

  it('wraps in both <strong><em> when bold and italic', () => {
    expect(applyFormattingToHtml(P('Hello'), { bold: true, italic: true }))
      .toBe(P('<strong><em>Hello</em></strong>'));
  });

  it('does not double-wrap <strong> if already present', () => {
    expect(applyFormattingToHtml(P('<strong>Hello</strong>'), { bold: true }))
      .toBe(P('<strong>Hello</strong>'));
  });

  // ── alignment ─────────────────────────────────────────────────────────

  it('adds text-align to style for center alignment', () => {
    expect(applyFormattingToHtml(P('Hello'), { alignment: 'center' }))
      .toBe(`<p class="" style="white-space:pre-wrap;text-align:center;">Hello</p>`);
  });

  it('replaces existing text-align', () => {
    const html = `<p class="" style="white-space:pre-wrap;text-align:left;">Hello</p>`;
    expect(applyFormattingToHtml(html, { alignment: 'right' }))
      .toBe(`<p class="" style="white-space:pre-wrap;text-align:right;">Hello</p>`);
  });

  // ── combined ──────────────────────────────────────────────────────────

  it('combines heading2 + bold + center alignment', () => {
    const result = applyFormattingToHtml(P('Hello'), {
      formatLevel: 'heading2',
      bold: true,
      alignment: 'center',
    });
    expect(result).toBe(
      `<h2 class="" style="white-space:pre-wrap;text-align:center;"><strong>Hello</strong></h2>`,
    );
  });

  // ── passthrough ───────────────────────────────────────────────────────

  it('returns HTML unchanged when no opts provided', () => {
    const html = P('Hello');
    expect(applyFormattingToHtml(html, {})).toBe(html);
  });
});
