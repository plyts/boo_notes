import { asciiFileName, safeFileName } from '../shared/encoding';
import { normalizeTitle } from '../shared/markdown';
import { PDF_DOCUMENT, PDF_JOB, picturePaths, type PdfJob, type PdfJobReply } from '../shared/pdf-job';
import type { PdfNote, PdfTranscript } from '../shared/pdf-notes';
import { isTimeKind, noteSlug, PLATFORM_LABELS } from '../shared/platforms';
import type { NoteStore } from '../shared/store';
import { TranscriptStore } from '../shared/transcript-store';

/**
 * « Télécharger en PDF »: one note (panel), one course (panel, options) or
 * every note (options), with their pictures, clickable moments and
 * passages — and, for a note or a course, the transcripts written out. Laid
 * out by the offscreen document (offscreen/pdf.ts), open for that time only.
 */

const KIND_LABELS: Record<string, string> = { audio: ' · Audio', page: ' · Lecture' };

/** The transcript of a note, as the PDF writes it (null: none). */
async function transcriptOf(transcripts: TranscriptStore, id: string): Promise<PdfTranscript | null> {
  const t = await transcripts.get(id).catch(() => null);
  if (!t?.cues.length) return null;
  return { label: t.label, cues: t.cues.map((c) => ({ start: c.start, text: c.text, ...(c.tr ? { tr: c.tr } : {}), ...(c.note ? { note: c.note } : {}) })) };
}

/**
 * Notes to put in the PDF (`ids`: null for all; `course`: the lessons of one
 * course). The library goes by course › chapter, then title; a course by its
 * chapters and lessons in the order they were begun. `transcripts`: written out.
 */
async function collect(store: NoteStore, ids: string[] | null, opts: { course?: string; transcripts?: boolean } = {}): Promise<Array<PdfNote & { timed: boolean }>> {
  const index = await store.listNotes();
  const want = opts.course ? normalizeTitle(opts.course) : null;
  const chosen = ids ?? Object.keys(index).filter((id) => !want || normalizeTitle(index[id]?.course ?? '') === want);
  const transcripts = new TranscriptStore(chrome.storage.local);
  const out: Array<PdfNote & { course: string; chapterName: string; createdAt: number; timed: boolean }> = [];
  for (const id of chosen) {
    const note = await store.getNote(id);
    if (!note) continue;
    const course = note.course ?? index[id]?.course ?? '';
    if (want && normalizeTitle(course) !== want) continue;
    const transcript = opts.transcripts ? await transcriptOf(transcripts, id) : null;
    // A lesson with nothing written but its transcript still belongs to its course.
    if (!note.markdown.trim() && !transcript) continue;
    const chapter = note.chapter ?? index[id]?.chapter ?? '';
    out.push({
      id,
      title: note.title || id,
      url: note.url,
      source: `${PLATFORM_LABELS[note.platform] ?? 'Web'}${KIND_LABELS[note.kind ?? ''] ?? ''}`,
      place: course ? `${course} › ${chapter || 'Chapitre 1'}` : null,
      chapter: course ? chapter || 'Chapitre 1' : null,
      updatedAt: note.updatedAt,
      markdown: note.markdown,
      ...(transcript ? { transcript } : {}),
      course,
      chapterName: chapter || 'Chapitre 1',
      createdAt: note.createdAt,
      // Notes before audio / PDF support are videos.
      timed: isTimeKind(note.kind ?? 'video'),
    });
  }
  const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });
  if (want) {
    // A course: its chapters in the order they were begun, their lessons too.
    const firstOf = new Map<string, number>();
    for (const n of out) firstOf.set(normalizeTitle(n.chapterName), Math.min(firstOf.get(normalizeTitle(n.chapterName)) ?? Infinity, n.createdAt));
    out.sort((a, b) => firstOf.get(normalizeTitle(a.chapterName))! - firstOf.get(normalizeTitle(b.chapterName))! || a.createdAt - b.createdAt || collator.compare(a.title, b.title));
  } else {
    out.sort((a, b) => {
      if (!a.course !== !b.course) return a.course ? -1 : 1;
      return collator.compare(a.course, b.course) || collator.compare(a.chapterName, b.chapterName) || collator.compare(a.title, b.title);
    });
  }
  return out.map(({ course: _course, chapterName: _chapter, createdAt: _at, ...note }) => note);
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

/**
 * Builds the PDF of `ids` (null: every note; `course`: the lessons of that
 * course, its transcripts written out) and saves it in « Boo Notes/ ».
 */
export async function downloadPdf(store: NoteStore, ids: string[] | null, now = new Date(), opts: { course?: string } = {}): Promise<string> {
  const one = Boolean(ids && ids.length === 1);
  const notes = await collect(store, ids, { course: opts.course, transcripts: one || Boolean(opts.course) });
  if (!notes.length) throw new Error(opts.course ? `Le cours « ${opts.course} » n’a pas encore de notes` : ids ? 'La note est vide' : 'Aucune note à exporter');
  const title = opts.course ?? (one ? notes[0].title : 'Toutes les notes');
  const pictures: Record<string, string> = {};
  for (const path of new Set(notes.flatMap((n) => picturePaths(n.markdown)))) {
    const asset = await store.getAsset(path);
    if (asset) pictures[path] = asset.dataUrl;
  }
  const base64 = await layOut({ target: PDF_JOB, notes, pictures, title, date: now.getTime(), ...(opts.course ? { course: true } : {}) });
  const day = now.toISOString().slice(0, 10);
  const name = opts.course
    ? safeFileName(`${opts.course} — cours (${day})`, 'cours')
    : one
      ? safeFileName(title, noteSlug(notes[0].id))
      : `Boo Notes — toutes les notes (${day})`;
  const url = `data:application/pdf;base64,${base64}`;
  const save = (n: string) => chrome.downloads.download({ url, filename: `Boo Notes/${n}.pdf`, conflictAction: 'uniquify', saveAs: false });
  try {
    await save(name);
  } catch (e) {
    // Some platforms / locales refuse non-ASCII file names.
    if (!/invalid filename/i.test(String(e))) throw e;
    await save(asciiFileName(name, 'boo-notes'));
  }
  if (opts.course) {
    const spoken = notes.filter((n) => n.transcript).length;
    return `PDF du cours « ${opts.course} » téléchargé : ${notes.length} leçon${notes.length > 1 ? 's' : ''}${spoken ? `, ${spoken} transcription${spoken > 1 ? 's' : ''}` : ''} — dans « Boo Notes »`;
  }
  const pages = notes.length > 1 ? `${notes.length} notes` : `« ${title} »`;
  return `PDF téléchargé : ${pages} dans « Boo Notes »`;
}
