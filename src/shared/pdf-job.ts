import type { PdfNote } from './pdf-notes';

/**
 * A PDF to lay out, sent by the service worker to its offscreen document
 * (offscreen/pdf.html): the PDF library stays out of the service worker,
 * which the browser starts again and again.
 */

export const PDF_JOB = 'offscreen:pdf';
export const PDF_DOCUMENT = 'offscreen/pdf.html';

export interface PdfJob {
  target: typeof PDF_JOB;
  notes: Array<PdfNote & { timed: boolean }>;
  /** Pictures the notes show (`assets/…` → data URL). */
  pictures: Record<string, string>;
  title: string;
  date: number;
}

export type PdfJobReply = { ok: true; base64: string } | { ok: false; error: string };

/** Pictures a note's Markdown shows (captures, pasted pictures, passage cards). */
export function picturePaths(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(/\]\((assets\/[^)\s]+)\)/g)].map((m) => m[1]))];
}
