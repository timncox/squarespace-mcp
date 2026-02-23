/**
 * PDF text extraction via pdf-parse.
 */

import pdf from 'pdf-parse';
import { logger } from '../utils/logger.js';

const MAX_TEXT_LENGTH = 30_000;

/**
 * Extract text content from a PDF buffer.
 * Truncates to 30,000 chars for very long documents.
 * Throws if no text could be extracted (e.g. scanned/image-only PDFs).
 */
export async function extractPdfText(buffer: Buffer): Promise<{ text: string; numPages: number }> {
  const result = await pdf(buffer);

  const rawText = result.text?.trim();
  if (!rawText) {
    throw new Error('No text could be extracted from the PDF. It may be a scanned or image-only document.');
  }

  let text = rawText;
  if (text.length > MAX_TEXT_LENGTH) {
    text = text.substring(0, MAX_TEXT_LENGTH) + '\n\n[PDF text truncated — showing first 30,000 characters]';
    logger.info({ originalLength: rawText.length }, 'PDF text truncated to 30,000 chars');
  }

  return { text, numPages: result.numpages };
}
