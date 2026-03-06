import { logger } from '../utils/logger.js';

export interface WaybackSnapshot {
  timestamp: string;
  displayDate: string;
  url: string;
}

export interface ExtractedSection {
  headings: string[];
  paragraphs: string[];
  images: { src: string; alt: string }[];
  links: { href: string; text: string }[];
}

export interface WaybackContent {
  pageTitle: string;
  sections: ExtractedSection[];
  metadata: {
    timestamp: string;
    originalUrl: string;
    waybackUrl: string;
  };
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

function stripWaybackUrl(src: string): string {
  return src.replace(/https?:\/\/web\.archive\.org\/web\/\d+(?:im_|id_|)\//, '');
}

function extractSection(html: string): ExtractedSection {
  const headings: string[] = [];
  const paragraphs: string[] = [];
  const images: { src: string; alt: string }[] = [];
  const links: { href: string; text: string }[] = [];

  let m: RegExpExecArray | null;

  const hRe = /<h[1-4][^>]*>(.*?)<\/h[1-4]>/gis;
  while ((m = hRe.exec(html)) !== null) {
    headings.push(stripHtmlTags(m[1]));
  }

  const pRe = /<p[^>]*>(.*?)<\/p>/gis;
  while ((m = pRe.exec(html)) !== null) {
    paragraphs.push(stripHtmlTags(m[1]));
  }

  const imgRe = /<img[^>]*?(?=src|alt)[^>]*>/gi;
  while ((m = imgRe.exec(html)) !== null) {
    const tag = m[0];
    const srcMatch = /src="([^"]*)"/.exec(tag);
    if (!srcMatch) continue;
    const altMatch = /alt="([^"]*)"/.exec(tag);
    images.push({ src: stripWaybackUrl(srcMatch[1]), alt: altMatch?.[1] ?? '' });
  }

  const aRe = /<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gis;
  while ((m = aRe.exec(html)) !== null) {
    links.push({ href: m[1], text: stripHtmlTags(m[2]) });
  }

  return { headings, paragraphs, images, links };
}

export async function listWaybackSnapshots(
  pageUrl: string,
  opts?: { limit?: number },
): Promise<WaybackSnapshot[]> {
  const limit = opts?.limit ?? 30;
  const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(pageUrl)}&output=json&fl=timestamp,statuscode&filter=statuscode:200&collapse=timestamp:8&limit=${limit}`;

  try {
    const resp = await fetch(cdxUrl, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) {
      logger.warn({ status: resp.status }, 'Wayback CDX API returned non-OK status');
      return [];
    }

    const rows = (await resp.json()) as string[][];
    if (rows.length <= 1) return [];

    return rows.slice(1).map(([timestamp]) => ({
      timestamp,
      displayDate: `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`,
      url: `https://web.archive.org/web/${timestamp}/${pageUrl}`,
    }));
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch Wayback snapshots');
    return [];
  }
}

export async function fetchWaybackContent(
  pageUrl: string,
  timestamp: string,
): Promise<WaybackContent> {
  const waybackUrl = `https://web.archive.org/web/${timestamp}id_/${pageUrl}`;
  const resp = await fetch(waybackUrl, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) {
    throw new Error(`Wayback fetch failed: ${resp.status} ${resp.statusText}`);
  }

  const html = await resp.text();

  const titleMatch = /<title>([^<]+)<\/title>/i.exec(html);
  const pageTitle = titleMatch ? stripHtmlTags(titleMatch[1].trim()) : '';

  const sectionDividerRe = /<div[^>]*class="[^"]*page-section[^"]*"[^>]*>/gi;
  const sectionStarts: number[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = sectionDividerRe.exec(html)) !== null) {
    sectionStarts.push(sm.index);
  }

  let sections: ExtractedSection[];
  if (sectionStarts.length > 0) {
    sections = sectionStarts.map((start, i) => {
      const end = i + 1 < sectionStarts.length ? sectionStarts[i + 1] : html.length;
      return extractSection(html.slice(start, end));
    });
  } else {
    const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
    const bodyHtml = bodyMatch ? bodyMatch[1] : html;
    sections = [extractSection(bodyHtml)];
  }

  return {
    pageTitle,
    sections,
    metadata: {
      timestamp,
      originalUrl: pageUrl,
      waybackUrl,
    },
  };
}
