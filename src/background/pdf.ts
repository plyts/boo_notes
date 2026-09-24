import { asciiFileName, safeFileName } from '../shared/encoding';
import { PDF_DOCUMENT, PDF_JOB, picturePaths, type PdfJob, type PdfJobReply } from '../shared/pdf-job';
import type { PdfNote } from '../shared/pdf-notes';
import { isTimeKind, noteSlug, PLATFORM_LABELS } from '../shared/platforms';
import type { NoteStore } from '../shared/store';

/**
 * « Télécharger en PDF »: one note (panel) or every note (options), sorted by
 * course › chapter, with their pictures, clickable moments and passages. Laid
 * out by the offscreen document (offscreen/pdf.ts), open for that time only.
 */

const KIND_LABELS: Record<string, string> = { audio: ' · Audio', page: ' · Lecture' };

/** Notes to put in the PDF (`ids`: null for all), sorted by course › chapter, then title. */
async function collect(store: NoteStore, ids: string[] | null): Promise<Array<PdfNote & { timed: boolean }>> {
  const index = await store.listNotes();
  const chosen = ids ?? Object.keys(index);
  const out: Array<PdfNote & { course: string; chapter: string; timed: boolean }> = [];
  for (const id of chosen) {
    const note = await store.getNote(id);
    if (!note || !note.markdown.trim()) continue;
    const course = note.course ?? index[id]?.course ?? '';
    const chapter = note.chapter ?? index[id]?.chapter ?? '';
    out.push({
      id,
      title: note.title || id,
      url: note.url,
      source: `${PLATFORM_LABELS[note.platform] ?? 'Web'}${KIND_LABELS[note.kind ?? ''] ?? ''}`,
      place: course ? `${course} › ${chapter || 'Chapitre 1'}` : null,
      updatedAt: note.updatedAt,
      markdown: note.markdown,
      course,
      chapter,
      // Notes before audio / PDF support are videos.
      timed: isTimeKind(note.kind ?? 'video'),
    });
  }
  const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });
  return out
    .sort((a, b) => {
      if (!a.course !== !b.course) return a.course ? -1 : 1;
      return collator.compare(a.course, b.course) || collator.compare(a.chapter, b.chapter) || collator.compare(a.title, b.title);
    })
    .map(({ course: _course, chapter: _chapter, ...note }) => note);
}

let opening: Promise<void> | null = null;
let jobs = 0;

async function openDocument(): Promise<void> {
  const url = chrome.runtime.getURL(PDF_DOCUMENT);
  const open = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], documentUrls: [url] });
  if (open.length) return;
  opening ??= chrome.offscreen
    .createDocument({ url: PDF_DOCUMENT, reasons: [chrome.offscreen.Reason.BLOBS], justification: 'Mise en page des notes en PDF' })
    .finally(() => {
      opening = null;
    });
  await opening;
}

/** Lays out `job` in the offscreen document: the PDF's bytes. */
async function layOut(job: PdfJob): Promise<string> {
  jobs++;
  try {
    await openDocument();
    let reply: PdfJobReply | undefined;
    // Its script may still be starting.
    for (let i = 0; i < 20 && !reply; i++) {
      reply = await (chrome.runtime.sendMessage(job) as Promise<PdfJobReply | undefined>).catch(() => undefined);
      if (!reply) await new Promise((r) => setTimeout(r, 100));
    }
    if (!reply) throw new Error('Mise en page du PDF indisponible');
    if (!reply.ok) throw new Error(reply.error);
    return reply.base64;
  } finally {
    if (--jobs === 0) await chrome.offscreen.closeDocument().catch(() => undefined);
  }
}

/** Builds the PDF of `ids` (null: every note) and saves it in « Boo Notes/ ». */
export async function downloadPdf(store: NoteStore, ids: string[] | null, now = new Date()): Promise<string> {
  const notes = await collect(store, ids);
  if (!notes.length) throw new Error(ids ? 'La note est vide' : 'Aucune note à exporter');
  const title = ids && notes.length === 1 ? notes[0].title : 'Toutes les notes';
  const pictures: Record<string, string> = {};
  for (const path of new Set(notes.flatMap((n) => picturePaths(n.markdown)))) {
    const asset = await store.getAsset(path);
    if (asset) pictures[path] = asset.dataUrl;
  }
  const base64 = await layOut({ target: PDF_JOB, notes, pictures, title, date: now.getTime() });
  const day = now.toISOString().slice(0, 10);
  const name = ids && notes.length === 1 ? safeFileName(title, noteSlug(notes[0].id)) : `Boo Notes — toutes les notes (${day})`;
  const url = `data:application/pdf;base64,${base64}`;
  const save = (n: string) => chrome.downloads.download({ url, filename: `Boo Notes/${n}.pdf`, conflictAction: 'uniquify', saveAs: false });
  try {
    await save(name);
  } catch (e) {
    // Some platforms / locales refuse non-ASCII file names.
    if (!/invalid filename/i.test(String(e))) throw e;
    await save(asciiFileName(name, 'boo-notes'));
  }
  const pages = notes.length > 1 ? `${notes.length} notes` : `« ${title} »`;
  return `PDF téléchargé : ${pages} dans « Boo Notes »`;
}
