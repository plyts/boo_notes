import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { findAssetRefs, normalizeTitle } from '../../../src/shared/markdown';
import { markdownToBlocks, type BlockSpec, type InlineContext, type RichText } from '../../../src/shared/notion/blocks';
import { KIND_LABELS, timestampUrl } from '../../../src/shared/platforms';
import { STATUS_LABELS } from '../../../src/shared/study';
import { extractCards, plainText, type Flashcard } from '../../../src/shared/cards';
import { formatTimecode } from '../../../src/shared/time';

export { extractCards, plainText, type Flashcard };
import { safeFileName, type Library } from './library';
import type { Note, Resource } from './types';
import { noteView } from './views';

/**
 * Export of the whole study base, meant to be kept, printed and revised:
 *
 * - `markdown`: one folder per course and chapter, one `.md` per note, captures in `assets/`;
 * - `sheets`: printable revision sheets (HTML, and PDF produced by the app);
 * - `cards`: flashcards for Anki / Quizlet (tab-separated), from the note syntax below;
 * - `json`: everything, structured (courses, chapters, notes, resources, cards) —
 *   the base for generating quizzes (QCM) later.
 *
 * Flashcards are written in the notes themselves:
 *   `Question :: Réponse`                  one line;
 *   a line, then `?` alone, then the answer (until a blank line);
 *   `## Une question ?` heading, answered by what follows (until the next heading / blank line);
 *   `==mot==` in a line: a cloze card hiding that word.
 */

export type ExportFormat = 'markdown' | 'sheets' | 'cards' | 'json';

export interface ExportOptions {
  formats: ExportFormat[];
  /** Courses to export (ids); every course when absent. */
  courses?: string[];
  /** Include the notes filed in no course. */
  includeUnfiled?: boolean;
}

export interface ExportResult {
  folder: string;
  notes: number;
  cards: number;
  files: string[];
  warnings: string[];
}

// --- Markdown → HTML (revision sheets) -------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function richHtml(items: RichText[]): string {
  return items
    .map((item) => {
      if (item.type === 'mention') return '<span class="mention">↗</span>';
      let html = esc(item.text.content).replace(/\n/g, '<br>');
      const a = item.annotations ?? {};
      if (a.code) html = `<code>${html}</code>`;
      if (a.bold) html = `<strong>${html}</strong>`;
      if (a.italic) html = `<em>${html}</em>`;
      if (a.strikethrough) html = `<s>${html}</s>`;
      const url = item.text.link?.url;
      return url ? `<a href="${esc(url)}">${html}</a>` : html;
    })
    .join('');
}

function blocksHtml(blocks: BlockSpec[], asset: (path: string) => string): string {
  let out = '';
  let list: 'ul' | 'ol' | null = null;
  const close = () => {
    if (list) out += `</${list}>`;
    list = null;
  };
  for (const b of blocks) {
    const kind = b.type === 'bulleted_list_item' || b.type === 'to_do' ? 'ul' : b.type === 'numbered_list_item' ? 'ol' : null;
    if (kind !== list) {
      close();
      if (kind) out += `<${kind}>`;
      list = kind;
    }
    switch (b.type) {
      case 'heading_1':
      case 'heading_2':
      case 'heading_3':
        out += `<h${Number(b.type.slice(-1)) + 2}>${richHtml(b.rich)}</h${Number(b.type.slice(-1)) + 2}>`;
        break;
      case 'quote':
        out += `<blockquote>${richHtml(b.rich)}</blockquote>`;
        break;
      case 'bulleted_list_item':
      case 'numbered_list_item':
      case 'to_do': {
        const box = b.type === 'to_do' ? (b.checked ? '☑ ' : '☐ ') : '';
        const children = b.children?.length ? `<ul>${b.children.map((c) => ('rich' in c ? `<li>${richHtml(c.rich)}</li>` : '')).join('')}</ul>` : '';
        out += `<li>${box}${richHtml(b.rich)}${children}</li>`;
        break;
      }
      case 'code':
        out += `<pre><code>${esc(b.text)}</code></pre>`;
        break;
      case 'divider':
        out += '<hr>';
        break;
      case 'image':
        out += `<figure><img src="${esc(asset(b.asset))}" alt=""><figcaption>${richHtml(b.caption)}</figcaption></figure>`;
        break;
      case 'external_image':
        out += `<figure><img src="${esc(b.url)}" alt=""><figcaption>${richHtml(b.caption)}</figcaption></figure>`;
        break;
      case 'video':
      case 'bookmark':
        out += `<p><a href="${esc(b.url)}">${esc(b.url)}</a></p>`;
        break;
      case 'callout':
        out += `<aside>${richHtml(b.rich)}</aside>`;
        break;
      default:
        out += `<p>${richHtml(b.rich)}</p>`;
    }
  }
  close();
  return out;
}

// --- Collect --------------------------------------------------------------------------------

interface ExportNote {
  note: Note;
  body: string;
  course: string | null;
  chapter: string | null;
  resources: Resource[];
  cards: Flashcard[];
}

interface ExportChapter {
  id: string;
  title: string;
  notes: ExportNote[];
}

interface ExportCourse {
  id: string;
  title: string;
  emoji: string;
  description?: string;
  chapters: ExportChapter[];
}

async function collect(lib: Library, opts: ExportOptions): Promise<{ courses: ExportCourse[]; unfiled: ExportNote[] }> {
  const wanted = opts.courses ? new Set(opts.courses) : null;
  const entry = async (note: Note, course: string | null, chapter: string | null): Promise<ExportNote> => {
    const body = await lib.readNote(note.id);
    return { note, body, course, chapter, resources: lib.resourcesOf(note), cards: extractCards(note.id, body) };
  };
  const courses: ExportCourse[] = [];
  for (const c of lib.listCourses()) {
    if (wanted && !wanted.has(c.id)) continue;
    const chapters: ExportChapter[] = [];
    for (const ch of c.chapters) {
      const notes: ExportNote[] = [];
      for (const id of ch.notes) {
        const note = lib.getNote(id);
        if (note?.noteFile) notes.push(await entry(note, c.title, ch.title));
      }
      chapters.push({ id: ch.id, title: ch.title, notes });
    }
    courses.push({ id: c.id, title: c.title, emoji: c.emoji, description: c.description, chapters });
  }
  const unfiled: ExportNote[] = [];
  if (opts.includeUnfiled ?? !wanted) {
    for (const note of lib.listNotes()) {
      if (note.noteFile && !lib.placement(note.id)) unfiled.push(await entry(note, null, null));
    }
  }
  return { courses, unfiled };
}

/** Links of anchors in exported text: the resource's page at the instant, or its name. */
function anchorContext(lib: Library, note: Note): InlineContext {
  const primary = note.resources[0] ?? null;
  const many = note.resources.length > 1;
  return {
    wiki: () => null,
    anchor: (kind, value, resource) => {
      const res = lib.getResource(resource ?? primary ?? '');
      if (!res) return null;
      const prefix = many ? `${res.title} · ` : '';
      const web = /^https?:\/\//.test(res.source);
      if (kind === 'time' && web && res.origin !== 'url') return { prefix, url: timestampUrl(res.source, value) };
      return { prefix, url: web ? res.source : null };
    },
  };
}

// --- Writers -----------------------------------------------------------------------------------

const folderName = (s: string, fallback: string) => safeFileName(s) || fallback;

function portableNote(lib: Library, e: ExportNote, assetPrefix: string): string {
  const primary = e.resources[0];
  const lines = [
    '---',
    `title: ${JSON.stringify(e.note.title)}`,
    ...(e.course ? [`course: ${JSON.stringify(e.course)}`] : []),
    ...(e.chapter ? [`chapter: ${JSON.stringify(e.chapter)}`] : []),
    ...(e.resources.length
      ? ['resources:', ...e.resources.map((r) => `  - ${JSON.stringify(`${KIND_LABELS[r.kind]} — ${r.title} — ${r.source}`)}`)]
      : []),
    `status: ${JSON.stringify(STATUS_LABELS[noteView(lib, e.note).studyStatus])}`,
    `updated: ${new Date(e.note.updatedAt).toISOString()}`,
    '---',
    '',
  ];
  let body = e.body;
  // Timestamps of an online video become links to the instant.
  if (primary && /^https?:\/\//.test(primary.source) && primary.origin !== 'url') {
    body = body.replace(/(?<!!)\[((?:\d+:)?\d{1,3}:\d{2})((?:\s?[–-]\s?(?:\d+:)?\d{1,3}:\d{2})?)\](?!\()/g, (_all, tc: string, end: string) => {
      const s = tc.split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
      return `[${tc}${end}](${timestampUrl(primary.source, s)})`;
    });
  }
  // Anchors about another resource: its name, and its link when it is online.
  body = body.replace(/(?<!!)\[([^\]\n]+)\]\(res:([^()\s]+)\)/g, (_all, label: string, id: string) => {
    const res = lib.getResource(id);
    if (!res) return `[${label}]`;
    const start = /^((?:\d+:)?\d{1,3}:\d{2})(?:\s?[–-]\s?(?:\d+:)?\d{1,3}:\d{2})?$/.exec(label)?.[1];
    const tc = start ? start.split(':').reduce((acc, p) => acc * 60 + Number(p), 0) : null;
    const url = /^https?:\/\//.test(res.source) ? (tc !== null && res.origin !== 'url' ? timestampUrl(res.source, tc) : res.source) : null;
    return url ? `[${res.title} · ${label}](${url})` : `[${res.title} · ${label}]`;
  });
  body = body.replace(/\]\(((?:assets|media|transcripts)\/[^)\s]+)\)/g, (_all, path: string) => `](${assetPrefix}${path})`);
  return lines.join('\n') + body;
}

const SHEET_CSS = `
:root { color-scheme: light; --ink: #1d1d1f; --muted: #6e6e73; --line: #d2d2d7; --accent: #6d5ef0; --card: #fff; --bg: #f5f5f7; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Segoe UI Variable Text", "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased; font-feature-settings: "kern", "liga", "cv11"; }
main { max-width: 820px; margin: 0 auto; padding: 48px 32px 80px; }
h1, h2, .course h2 { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter Display", "Inter", "Segoe UI Variable Display", "Segoe UI", sans-serif; letter-spacing: -0.02em; }
header.cover h1 { font-size: 34px; margin: 0 0 6px; }
header.cover p { color: var(--muted); margin: 0; }
.course { margin-top: 48px; }
.course > h2 { font-size: 28px; margin: 0 0 4px; }
.course > p { color: var(--muted); margin: 0 0 16px; }
.chapter > h3 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 28px 0 10px; }
article { background: var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 22px 26px; margin: 0 0 16px; break-inside: avoid; }
article h4 { font-size: 20px; margin: 0 0 4px; letter-spacing: -0.01em; }
.meta { color: var(--muted); font-size: 13px; margin: 0 0 12px; }
.resources { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 14px; padding: 0; list-style: none; }
.resources li { font-size: 12px; padding: 3px 10px; border-radius: 999px; background: #f0eefe; color: #3d2fb8; }
article h5, article h6 { font-size: 15px; margin: 16px 0 6px; }
blockquote { margin: 10px 0; padding: 6px 14px; border-left: 3px solid var(--accent); background: #f7f6ff; border-radius: 0 10px 10px 0; }
code { font-family: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace; font-size: 0.88em; background: #f2f2f5; padding: 1px 5px; border-radius: 5px; }
pre { background: #f2f2f5; padding: 12px 14px; border-radius: 12px; overflow: auto; }
pre code { background: none; padding: 0; }
figure { margin: 12px 0; } figure img { max-width: 100%; border-radius: 12px; } figcaption { color: var(--muted); font-size: 12px; }
aside { background: #f5f5f7; border-radius: 12px; padding: 8px 12px; color: var(--muted); }
a { color: var(--accent); text-decoration: none; }
.cards { margin-top: 16px; border-top: 1px dashed var(--line); padding-top: 12px; }
.cards h5 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.card { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 8px 0; border-bottom: 1px solid #eee; }
.card .q { font-weight: 600; } .card .a { color: #2c2c2e; }
@media print { body { background: #fff; } main { padding: 0; } article { border-color: #ddd; } .course { break-before: page; } .course:first-of-type { break-before: auto; } }
`;

function sheetsHtml(lib: Library, data: { courses: ExportCourse[]; unfiled: ExportNote[] }, assetPrefix: string): string {
  const noteHtml = (e: ExportNote) => {
    const view = noteView(lib, e.note);
    const blocks = markdownToBlocks(e.body, anchorContext(lib, e.note));
    const meta = [e.course && e.chapter ? `${e.course} › ${e.chapter}` : '', STATUS_LABELS[view.studyStatus], view.positionLabel]
      .filter(Boolean)
      .join(' · ');
    const resources = e.resources.length
      ? `<ul class="resources">${e.resources.map((r) => `<li>${esc(KIND_LABELS[r.kind])} · ${esc(r.title)}</li>`).join('')}</ul>`
      : '';
    const cards = e.cards.length
      ? `<section class="cards"><h5>Cartes de révision</h5>${e.cards
          .map((c) =>
            c.type === 'cloze'
              ? `<div class="card"><span class="q">${esc(c.front.replace(/\{\{c\d+::(.+?)\}\}/g, '[…]'))}</span><span class="a">${esc(c.front.replace(/\{\{c\d+::(.+?)\}\}/g, '$1'))}</span></div>`
              : `<div class="card"><span class="q">${esc(c.front)}</span><span class="a">${esc(c.back)}</span></div>`,
          )
          .join('')}</section>`
      : '';
    return `<article><h4>${esc(e.note.title)}</h4><p class="meta">${esc(meta)}</p>${resources}${blocksHtml(blocks, (p) => assetPrefix + p)}${cards}</article>`;
  };
  const courses = data.courses
    .map(
      (c) =>
        `<section class="course"><h2>${esc(`${c.emoji} ${c.title}`)}</h2>${c.description ? `<p>${esc(c.description)}</p>` : ''}${c.chapters
          .filter((ch) => ch.notes.length)
          .map((ch) => `<section class="chapter"><h3>${esc(ch.title)}</h3>${ch.notes.map(noteHtml).join('')}</section>`)
          .join('')}</section>`,
    )
    .join('');
  const unfiled = data.unfiled.length
    ? `<section class="course"><h2>Notes non classées</h2>${data.unfiled.map(noteHtml).join('')}</section>`
    : '';
  const date = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Fiches de révision — Boo Notes</title><style>${SHEET_CSS}</style></head><body><main><header class="cover"><h1>Fiches de révision</h1><p>Boo Notes · ${esc(date)}</p></header>${courses}${unfiled}</main></body></html>`;
}

function ankiField(s: string): string {
  return esc(s).replace(/\t/g, ' ').replace(/\n/g, '<br>');
}

const tag = (s: string) => normalizeTitle(s).replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || 'x';

function cardFiles(data: { courses: ExportCourse[]; unfiled: ExportNote[] }): { basic: string; cloze: string; count: number } {
  const basic: string[] = ['#separator:tab', '#html:true', '#notetype:Basic', '#deck column:3', '#tags column:4'];
  const cloze: string[] = ['#separator:tab', '#html:true', '#notetype:Cloze', '#deck column:3', '#tags column:4'];
  let count = 0;
  const all = [...data.courses.flatMap((c) => c.chapters.flatMap((ch) => ch.notes)), ...data.unfiled];
  for (const e of all) {
    const deck = `Boo Notes::${(e.course ?? 'Non classées').replace(/::/g, ':')}`;
    const tags = ['boo', e.course ? `cours::${tag(e.course)}` : '', e.chapter ? `chapitre::${tag(e.chapter)}` : '', `note::${tag(e.note.title)}`]
      .filter(Boolean)
      .join(' ');
    for (const c of e.cards) {
      count++;
      if (c.type === 'cloze') cloze.push([ankiField(c.front), ankiField(e.note.title), deck, tags].join('\t'));
      else basic.push([ankiField(c.front), ankiField(c.back), deck, tags].join('\t'));
    }
  }
  return { basic: `${basic.join('\n')}\n`, cloze: `${cloze.join('\n')}\n`, count };
}

function jsonExport(lib: Library, data: { courses: ExportCourse[]; unfiled: ExportNote[] }): unknown {
  const noteJson = (e: ExportNote) => {
    const view = noteView(lib, e.note);
    return {
      id: e.note.id,
      title: e.note.title,
      course: e.course,
      chapter: e.chapter,
      resources: e.resources.map((r) => r.id),
      markdown: e.body,
      text: plainText(e.body),
      links: e.note.links ?? [],
      status: view.studyStatus,
      progress: Math.round(view.ratio * 1000) / 1000,
      review: e.note.review ?? null,
      cards: e.cards.map((c) => c.id),
      createdAt: new Date(e.note.createdAt).toISOString(),
      updatedAt: new Date(e.note.updatedAt).toISOString(),
    };
  };
  const all = [...data.courses.flatMap((c) => c.chapters.flatMap((ch) => ch.notes)), ...data.unfiled];
  const resources = new Map<string, Resource>();
  for (const e of all) for (const r of e.resources) resources.set(r.id, r);
  return {
    format: 'boo-notes-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    courses: data.courses.map((c) => ({
      id: c.id,
      title: c.title,
      emoji: c.emoji,
      description: c.description ?? null,
      chapters: c.chapters.map((ch) => ({ id: ch.id, title: ch.title, notes: ch.notes.map((e) => e.note.id) })),
    })),
    notes: all.map(noteJson),
    resources: [...resources.values()].map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      source: r.source,
      platform: r.platform,
      position: r.progress ? { value: r.progress.position, of: r.progress.duration, label: r.kind === 'video' || r.kind === 'audio' ? formatTimecode(r.progress.position) : null } : null,
    })),
    cards: all.flatMap((e) => e.cards.map((c) => ({ ...c, course: e.course, chapter: e.chapter, note: e.note.title }))),
  };
}

/**
 * Writes the export into `folder`. Returns the files written; the PDF of the
 * revision sheets is produced by the app from `Fiches de révision.html`.
 */
export async function writeExport(lib: Library, folder: string, opts: ExportOptions): Promise<ExportResult & { sheetsHtml: string | null }> {
  const data = await collect(lib, opts);
  const files: string[] = [];
  const warnings: string[] = [];
  const all = [...data.courses.flatMap((c) => c.chapters.flatMap((ch) => ch.notes)), ...data.unfiled];
  await mkdir(folder, { recursive: true });
  const write = async (rel: string, text: string) => {
    const abs = join(folder, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, text, 'utf8');
    files.push(rel);
  };

  // Captures used by the exported notes, copied once.
  const assets = new Set(all.flatMap((e) => findAssetRefs(e.body)));
  if (opts.formats.includes('markdown') || opts.formats.includes('sheets')) {
    for (const rel of assets) {
      try {
        await mkdir(join(folder, 'assets'), { recursive: true });
        await copyFile(lib.assetPath(rel), join(folder, rel));
      } catch {
        warnings.push(`Capture introuvable : ${rel}`);
      }
    }
  }

  if (opts.formats.includes('markdown')) {
    const used = new Set<string>();
    const unique = (path: string) => {
      let p = path;
      for (let n = 2; used.has(p.toLowerCase()); n++) p = path.replace(/\.md$/, ` (${n}).md`);
      used.add(p.toLowerCase());
      return p;
    };
    const index: string[] = ['# Boo Notes — mes cours', ''];
    for (const c of data.courses) {
      const cDir = join('Cours', folderName(`${c.title}`, c.id.replace(/\W+/g, '-')));
      index.push(`## ${c.emoji} ${c.title}`, '');
      for (const [i, ch] of c.chapters.entries()) {
        const chDir = join(cDir, folderName(`${String(i + 1).padStart(2, '0')} - ${ch.title}`, `${i + 1}`));
        if (ch.notes.length) index.push(`### ${ch.title}`, '');
        for (const e of ch.notes) {
          const rel = unique(join(chDir, `${folderName(e.note.title, 'Note')}.md`));
          const up = relative(dirname(join(folder, rel)), folder).split('\\').join('/');
          await write(rel, portableNote(lib, e, up ? `${up}/` : ''));
          index.push(`- [${e.note.title}](${encodeURI(rel.split('\\').join('/'))})`);
        }
        if (ch.notes.length) index.push('');
      }
    }
    if (data.unfiled.length) {
      index.push('## Notes non classées', '');
      for (const e of data.unfiled) {
        const rel = unique(join('Non classées', `${folderName(e.note.title, 'Note')}.md`));
        await write(rel, portableNote(lib, e, '../'));
        index.push(`- [${e.note.title}](${encodeURI(rel.split('\\').join('/'))})`);
      }
    }
    await write('README.md', `${index.join('\n')}\n`);
  }

  let sheets: string | null = null;
  if (opts.formats.includes('sheets')) {
    await write('Fiches de révision.html', sheetsHtml(lib, data, ''));
    sheets = join(folder, 'Fiches de révision.html');
  }

  const cards = cardFiles(data);
  if (opts.formats.includes('cards')) {
    await write('Cartes - questions (Anki).txt', cards.basic);
    await write('Cartes - textes à trous (Anki).txt', cards.cloze);
    if (!cards.count) warnings.push('Aucune carte : écrivez « Question :: Réponse » dans vos notes');
  }

  if (opts.formats.includes('json')) {
    await write('boo-notes.json', `${JSON.stringify(jsonExport(lib, data), null, 2)}\n`);
  }

  return { folder, notes: all.length, cards: cards.count, files, warnings, sheetsHtml: sheets };
}
