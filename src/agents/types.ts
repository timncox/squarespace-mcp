/**
 * Shared types for the multi-agent content planning pipeline.
 *
 * Agent pipeline: Research → Site Analyst → Content Strategist → Editor (browser agent)
 */

import type { PageDiff } from '../services/site-reader.js';

// ─── Content Plan (output of Content Strategist, input to Editor Agent) ─────

export interface ContentPlan {
  /** Human-readable summary for Tim's WhatsApp approval message */
  summary: string;
  /** Individual content operations, ordered by execution sequence */
  operations: ContentOperation[];
  /** Research source URLs cited */
  sources: string[];
  /** Rough estimate of browser agent execution time */
  estimatedMinutes: number;
}

export interface ContentOperation {
  /** Which task this operation belongs to */
  taskId: string;
  /** The site to edit (subdomain) */
  siteId: string;
  /** The page to edit (slug, e.g., "home", "menus") */
  targetPage: string;
  /** What type of edit */
  operationType:
    | 'create_page'
    | 'add_section'
    | 'add_block'
    | 'modify_text'
    | 'replace_image'
    | 'remove_block'
    | 'modify_block'
    | 'modify_style';
  /** Where on the page (e.g., "below the hero section", "replace the current mountain image") */
  placement: string;
  /** The exact content to use */
  content: ContentSpec;
  /**
   * Detailed instruction for the browser agent.
   * This replaces the vague task.description with precise step-by-step editing instructions.
   * The browser agent should follow these VERBATIM.
   */
  editorInstruction: string;
}

export interface ContentSpec {
  /** For text content: the exact heading */
  heading?: string;
  /** For text content: the exact body copy */
  bodyText?: string;
  /** For buttons: label and destination URL */
  button?: { label: string; url: string };
  /** For images: description/search query (for stock photo search) */
  imageQuery?: string;
  /** Absolute file path to an image to upload (for addImageBlock) */
  imagePath?: string;
  /** Alt text for the uploaded image */
  imageAltText?: string;
  /** The Squarespace block type to use */
  blockType?: 'text' | 'button' | 'image' | 'markdown' | 'spacer' | 'menu' | 'quote' | 'code' | 'embed' | 'form' | 'line' | 'divider' | 'video' | 'gallery';
  /** Section color theme name (e.g., "Dark", "Lightest") */
  sectionTheme?: string;
  /** Section height setting */
  sectionHeight?: 'auto' | 'small' | 'medium' | 'large' | 'full';
  /** Content width setting */
  contentWidth?: 'inset' | 'full';
  /** Vertical alignment within section */
  verticalAlignment?: 'top' | 'middle' | 'bottom';
  /** Overlay opacity for background images (0-100) */
  overlayOpacity?: number;
  /** Section padding (top/bottom) */
  sectionPadding?: 'none' | 'small' | 'medium' | 'large';
  /** Gap between blocks in section */
  blockSpacing?: 'none' | 'small' | 'medium' | 'large';
  /** Text formatting: heading level or paragraph style */
  textFormatLevel?: 'heading1' | 'heading2' | 'heading3' | 'heading4' | 'paragraph1' | 'paragraph2' | 'paragraph3' | 'monospace';
  /** Text formatting: bold */
  textBold?: boolean;
  /** Text formatting: italic */
  textItalic?: boolean;
  /** Text formatting: alignment */
  textAlignment?: 'left' | 'center' | 'right';
  /** Text formatting: relative font size adjustment */
  textFontSize?: 'increase' | 'decrease';
  /** Button design: size */
  buttonSize?: 'small' | 'medium' | 'large';
  /** Button design: style variant */
  buttonStyle?: 'primary' | 'secondary' | 'tertiary';
  /** Button design: alignment */
  buttonAlignment?: 'left' | 'center' | 'right';
  /** Section template category tab (e.g., "About", "Services", "Contact", "Team") */
  templateCategory?: string;
  /** Section template name to search for within the category (e.g., "Bio with Image", "Team Grid") */
  templateName?: string;
  /** Content strategy for this operation */
  contentStrategy?: 'template' | 'blank_api' | 'manual';
  /** For blank_api strategy: text blocks to add via Content Save API */
  apiBlocks?: Array<{ html: string; layout?: { columns?: number } }>;
  /** Template index for position-based selection (0-based) */
  templateIndex?: number;
  /** Structured replacements for template sections (texts, buttons, images, block removals) */
  replacements?: {
    texts?: Array<{ searchText: string; newText: string }>;
    buttons?: Array<{ searchText: string; newLabel?: string; url?: string }>;
    images?: Array<{ searchText: string; imagePath: string; altText?: string }>;
    removeBlocks?: string[];
  };
}

// ─── Page Structure (from Content Save API, input to Content Strategist) ────

/** Summary of a single block within a section */
export interface BlockSummary {
  /** Block type (e.g., "text", "image", "button", "code", "quote") */
  type: string;
  /** First 100 chars of text content (stripped HTML) */
  textSnippet?: string;
  /** Image alt text or title */
  imageAlt?: string;
  /** Button label */
  buttonLabel?: string;
  /** Button URL */
  buttonUrl?: string;
}

/** Summary of a single section on the page */
export interface SectionSummary {
  /** Section ID from Squarespace */
  id: string;
  /** 0-based position on the page */
  index: number;
  /** Section name (from Squarespace metadata) */
  name: string;
  /** Number of blocks in this section */
  blockCount: number;
  /** Summary of blocks in this section */
  blocks: BlockSummary[];
}

/** Full page structure summary for a single page */
export interface PageStructure {
  /** Total number of sections on the page */
  sectionCount: number;
  /** Ordered list of section summaries */
  sections: SectionSummary[];
}

// ─── Research Agent Output ──────────────────────────────────────────────────

export interface ResearchResult {
  /** The search queries that were run */
  queries: string[];
  /** Structured findings (key facts) */
  findings: string[];
  /** Source URLs */
  sources: string[];
  /** Raw search snippets passed to the content strategist for context */
  rawSnippets: string[];
  /** Synthesized research output (replaces raw snippets for strategist consumption) */
  synthesis?: ResearchSynthesis;
  /** Structured data extracted from URLs in the task description */
  structuredPages?: StructuredPageData[];
}

// ─── Research Synthesis (produced by synthesis step) ────────────────────────

export interface ResearchSynthesis {
  /** Key facts extracted and verified from multiple sources */
  keyFacts: string[];
  /** Suggested content angles and copy ideas for the strategist */
  contentSuggestions: string[];
  /** Tone and voice guidance derived from research context */
  toneGuidance: string;
  /** Sources ranked by relevance to the task */
  sources: Array<{ url: string; relevance: 'high' | 'medium' | 'low'; summary: string }>;
}

// ─── Structured Page Data (extracted from URLs) ─────────────────────────────

export interface StructuredPageData {
  /** The URL that was visited */
  url: string;
  /** Page title (from <title> or <h1>) */
  title: string;
  /** Headings hierarchy (h1-h3) found on the page */
  headings: string[];
  /** Key content paragraphs extracted from the page */
  keyContent: string[];
  /** Images found on the page */
  images: Array<{ src: string; alt: string }>;
  /** Lists found on the page (each inner array is one list's items) */
  lists: string[][];
}

// ─── Site Analyst Agent Output ──────────────────────────────────────────────

export interface SiteAnalysis {
  /** Path to the screenshot taken of the current page */
  screenshotPath: string;
  /** Description of the page's visual style */
  styleDescription: string;
  /** List of existing content sections found on the page */
  existingSections: string[];
  /** The site's brand tone (e.g., "upscale modern", "casual bistro", "refined Italian") */
  brandTone: string;
  /** Observations about fonts, colors, layout patterns */
  visualNotes: string;
}

// ─── Generic Agent Result Wrapper ───────────────────────────────────────────

export interface AgentResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  tokenUsage: { inputTokens: number; outputTokens: number };
  durationMs: number;
}

// ─── Supervisor Agent Types ─────────────────────────────────────────────────

export interface SupervisorVerdict {
  /** Did the agent accomplish the requested task? */
  status: 'pass' | 'fail' | 'unclear';
  /** What the supervisor actually sees on the page */
  observedState: string;
  /** What was expected based on the task description */
  expectedState: string;
  /** Specific diagnosis of what went wrong (only for 'fail') — written for Tim to read on WhatsApp */
  diagnosis?: string;
  /** Corrective instructions for the browser agent retry (only for 'fail') */
  correctiveInstructions?: string;
  /** Confidence level 0-1 */
  confidence: number;
  /** JSON-based verification evidence from SiteReader (supplementary to screenshot + DOM) */
  jsonEvidence?: JsonVerificationEvidence;
}

export interface SupervisorResult {
  /** Final verdict after verification (and optional retry) */
  verdict: SupervisorVerdict;
  /** Was a retry attempted? */
  retryAttempted: boolean;
  /** Result of the retry (if attempted) */
  retryResult?: {
    success: boolean;
    summary: string;
    screenshotPath?: string;
  };
  /** Path to the verification screenshot */
  verificationScreenshotPath?: string;
  /** Token usage for the supervisor's own Claude calls */
  tokenUsage: { inputTokens: number; outputTokens: number };
  /** Duration of the supervision process (verification + optional retry) */
  durationMs: number;
  /** Whether JSON verification via SiteReader was available and used */
  jsonVerificationUsed?: boolean;
}

// ─── JSON Verification Evidence (from SiteReader) ───────────────────────────

/** JSON diff evidence from SiteReader pre/post comparison */
export interface JsonVerificationEvidence {
  /** Whether the SiteReader was able to read both before and after snapshots */
  available: boolean;
  /** Human-readable summary of what changed in the JSON */
  summary: string;
  /** Whether the diff detected any changes at all */
  changesDetected: boolean;
  /** The structured diff (from SiteReader.diffPages) */
  diff?: PageDiff;
  /** Extracted blocks from the "after" snapshot for content verification */
  afterBlocks?: ExtractedBlockSummary[];
  /** Error message if SiteReader failed */
  error?: string;
}

/** Lightweight block summary for LLM prompt inclusion */
export interface ExtractedBlockSummary {
  type: string;
  text?: string;
  buttonText?: string;
  buttonUrl?: string;
  imageAlt?: string;
  hasImage: boolean;
}
