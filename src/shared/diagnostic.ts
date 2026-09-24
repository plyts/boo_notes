import type { ScormState } from './messages';

/**
 * « Diagnostic de cette page » (right click on the Boo Notes icon): what
 * Boo Notes sees of a page — its frames (course module, LMS player, embedded
 * video), the media in each, the SCORM API, the rights it has — and what
 * blocks it, in plain words. A report to read, or to copy for help. Nothing
 * of the notes, and addresses without their query (tokens).
 */

/** What the content script of the page knows. */
export interface PageState {
  context: { platform: string; noteId: string } | null;
  mode: string;
  source: 'element' | 'frame' | 'stopwatch' | null;
  media: { tag: string; width: number; height: number; duration: number; drm: boolean } | null;
  /** Frames whose agent reports a media. */
  mediaFrames: number;
  /** Frames the panel asks to allow (hosts, `*` for a hidden address). */
  blocked: string[];
  /** A course module in a frame is followed (quotes, headings). */
  moduleFollowed: boolean;
  scorm: ScormState | null;
  notesOpen: boolean;
  popout: boolean;
  /** The notes panel as seen on screen. */
  panel?: {
    /** Its frame loaded (connected to the page). */
    loaded: boolean;
    /** Element of the page drawn above it, null when it is seen. */
    coveredBy: string | null;
    /** Where it lives: fullscreen element, modal dialog, popover (null: the page). */
    layer: string | null;
    fullscreen: string | null;
  };
  /** Last errors shown to the user (toasts). */
  errors: string[];
}

export interface FrameInfo {
  src: string;
  width: number;
  height: number;
  /** Same-origin document the probe can read. */
  reachable: boolean;
  sandbox: string | null;
  allow: string;
}

export interface MediaInfo {
  tag: string;
  src: string;
  width: number;
  height: number;
  readyState: number;
  paused: boolean;
  duration: number | null;
  drm: boolean;
}

/** One frame the extension could read (isolated world). */
export interface FrameProbe {
  frameId: number;
  url: string;
  top: boolean;
  title: string;
  /** Boo Notes' agent / content script runs there. */
  agent: boolean;
  app: boolean;
  frames: FrameInfo[];
  media: MediaInfo[];
  textLength: number;
  /** Authoring tool of a course module (Articulate Rise 360, Storyline, Captivate, iSpring). */
  tool?: string;
  /** Video-looking blocks with no <video> in them yet (poster, player not loaded). */
  videoBlocks?: number;
  /** Main world: the SCORM API of this frame or of a parent, the media bridge. */
  scorm?: { api12: boolean; api2004: boolean; parent: 'found' | 'none' | 'cross-origin' };
  bridge?: boolean;
}

export interface Diagnostic {
  at: number;
  version: string;
  browser: string;
  tab: { url: string; title: string };
  permissions: { site: boolean; all: boolean };
  /** The content script (null: not running in the tab). */
  content: PageState | null;
  /** Error of the injection of Boo Notes in the tab, if any. */
  injectError: string | null;
  frames: FrameProbe[];
  sync: { desktop: string; notion: string };
}

export interface Finding {
  level: 'ok' | 'warn' | 'error';
  text: string;
}

/** An address without its query and fragment (they may hold tokens). */
export function bareUrl(url: string): string {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? `${u.origin}${u.pathname}` : `${u.protocol}${u.pathname ? '…' : ''}`;
  } catch {
    return url.slice(0, 80);
  }
}

// --- Probes (run in the page's frames: self-contained, nothing from outside) ----------------

/** Isolated world of each frame the extension may read. */
export function probeFrame(): Omit<FrameProbe, 'frameId'> {
  const bare = (url: string): string => {
    try {
      const u = new URL(url, location.href);
      return /^https?:$/.test(u.protocol) ? `${u.origin}${u.pathname}` : `${u.protocol}${u.pathname ? '…' : ''}`;
    } catch {
      return String(url).slice(0, 80);
    }
  };
  const size = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { width: Math.round(r.width), height: Math.round(r.height) };
  };
  // Media in open shadow trees too (web components of players).
  const all = (selector: string): Element[] => {
    const out: Element[] = [];
    const visit = (root: Document | ShadowRoot, depth: number) => {
      out.push(...root.querySelectorAll(selector));
      if (depth > 4) return;
      for (const el of root.querySelectorAll('*')) {
        // Closed trees too (content scripts may open them).
        let shadow: ShadowRoot | null = el.shadowRoot;
        try {
          shadow ??= (chrome as unknown as { dom?: { openOrClosedShadowRoot?(e: Element): ShadowRoot | null } }).dom?.openOrClosedShadowRoot?.(el) ?? null;
        } catch {
          shadow = null;
        }
        if (shadow) visit(shadow, depth + 1);
      }
    };
    visit(document, 0);
    return out;
  };
  const w = window as unknown as Record<string, unknown>;
  return {
    url: bare(location.href),
    top: window.top === window,
    title: document.title.slice(0, 120),
    agent: Boolean(w.__booNotesFrameAgent),
    app: Boolean(w.__booNotesContentApp),
    // The page's frames (Boo Notes' own panel aside).
    frames: all('iframe, frame').filter((f) => !/^chrome-extension:/.test((f as HTMLIFrameElement).src)).map((f) => {
      const frame = f as HTMLIFrameElement;
      let reachable = false;
      try {
        reachable = frame.contentDocument !== null;
      } catch {
        reachable = false;
      }
      return {
        src: frame.getAttribute('src') ? bare(frame.src) : '(sans adresse)',
        ...size(frame),
        reachable,
        sandbox: frame.getAttribute('sandbox'),
        allow: frame.getAttribute('allow') ?? '',
      };
    }),
    media: all('video, audio').map((el) => {
      const m = el as HTMLMediaElement;
      const src = m.currentSrc || m.getAttribute('src') || '';
      return {
        tag: m.tagName.toLowerCase(),
        src: src.startsWith('blob:') ? 'blob: (flux HLS / DASH)' : src ? bare(src) : '',
        ...size(m),
        readyState: m.readyState,
        paused: m.paused,
        duration: Number.isFinite(m.duration) ? Math.round(m.duration) : null,
        drm: Boolean(m.mediaKeys),
      };
    }),
    textLength: (document.body?.innerText ?? '').length,
    tool: document.querySelector('#preso, script[src*="story_content"]')
      ? 'Articulate Storyline'
      : /\/scormcontent\//.test(location.pathname)
        ? 'Articulate Rise 360'
        : document.querySelector('script[src*="CPM.js" i], #cpDocument')
          ? 'Adobe Captivate'
          : document.querySelector('script[src*="ispring" i], [class*="ispring" i]')
            ? 'iSpring'
            : undefined,
    videoBlocks: all('[class*="video" i], [data-block-type*="video" i]').filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width >= 200 && r.height >= 110 && !el.querySelector('video, iframe') && !el.closest('video');
    }).length,
  };
}

/** Main world of each frame: the SCORM API (here or in a parent window) and the media bridge. */
export function probeMainWorld(): Pick<FrameProbe, 'scorm' | 'bridge'> {
  const w = window as unknown as Record<string, unknown>;
  let parent: 'found' | 'none' | 'cross-origin' = 'none';
  try {
    for (let p = window.parent as Window & Record<string, unknown>, i = 0; i < 10; p = p.parent as Window & Record<string, unknown>, i++) {
      if (p === (window as unknown)) break;
      if (p.API || p.API_1484_11) {
        parent = 'found';
        break;
      }
      if (p === p.parent) break;
    }
  } catch {
    parent = 'cross-origin';
  }
  return { scorm: { api12: Boolean(w.API), api2004: Boolean(w.API_1484_11), parent }, bridge: Boolean(w.__booNotesMediaBridge) };
}

// --- Reading ----------------------------------------------------------------------------------

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

/** Frames big enough to hold a lesson or a player. */
const bigFrame = (f: FrameInfo) => f.width * f.height >= 240 * 135;

/** Frames of the page Boo Notes cannot read: listed by the frames that hold them. */
export function unreadFrames(d: Diagnostic): FrameInfo[] {
  const read = new Set(d.frames.map((p) => p.url));
  // Web pages only (data: / blob: documents are no site to allow); no address: gone elsewhere.
  const web = (f: FrameInfo) => /^https?:/.test(f.src) || f.src === '(sans adresse)' || f.src.startsWith('about:');
  return d.frames.flatMap((p) => p.frames.filter((f) => bigFrame(f) && web(f) && !f.reachable && !read.has(f.src)));
}

/** What blocks Boo Notes on the page, in plain words (most important first). */
export function findings(d: Diagnostic): Finding[] {
  const out: Finding[] = [];
  const c = d.content;
  if (!c) {
    out.push({
      level: 'error',
      text: d.injectError
        ? `Boo Notes ne peut pas démarrer dans cet onglet (${d.injectError}). Page interne du navigateur, Chrome Web Store, visionneuse PDF ou site interdit par une règle d’entreprise ?`
        : 'Boo Notes ne tourne pas dans cet onglet : cliquez son icône (ou Alt+Maj+N) sur la page, puis relancez le diagnostic.',
    });
  } else if (!c.context) {
    out.push({ level: 'error', text: 'Boo Notes tourne mais ne reconnaît pas cette adresse comme une page à annoter.' });
  } else {
    const panel = c.panel;
    if (c.notesOpen && panel && !panel.loaded) {
      out.push({ level: 'error', text: 'Le panneau des notes est ouvert mais son contenu ne s’est pas chargé dans cette page : Boo Notes l’ouvre dans une fenêtre à part (même note).' });
    } else if (c.notesOpen && panel?.coveredBy) {
      out.push({
        level: 'error',
        text: `Le panneau des notes est ouvert mais invisible : la page le recouvre (${panel.coveredBy}). Boo Notes le passe au premier plan, sinon ouvre les notes dans une fenêtre à part.`,
      });
    } else {
      out.push({ level: 'ok', text: `Boo Notes est actif sur cette page${c.popout ? ', notes dans une fenêtre à part' : c.notesOpen ? ', notes ouvertes et visibles' : ' (notes fermées)'}.` });
    }
    if (panel?.fullscreen) out.push({ level: 'ok', text: `Page en plein écran : ${panel.fullscreen}.` });
    if (panel?.layer && panel.layer !== panel.fullscreen) out.push({ level: 'ok', text: `La page affiche la leçon au premier plan (${panel.layer}) : les notes s’y placent.` });
  }

  const unread = unreadFrames(d);
  if (unread.length) {
    const hosts = [...new Set(unread.map((f) => (f.src.startsWith('http') ? hostOf(f.src) : 'adresse masquée')))];
    out.push({
      level: 'error',
      text: `${unread.length} cadre${unread.length > 1 ? 's' : ''} de la page (${hosts.join(', ')}) — le module du cours ou son lecteur vidéo — ${unread.length > 1 ? 'sont illisibles' : 'est illisible'} pour Boo Notes : Chrome ne lui a pas donné accès à ${hosts.length > 1 ? 'ces sites' : 'ce site'}. Cliquez « Autoriser » dans le panneau des notes, ou activez « Tous les sites » dans les réglages (section Sites), puis rechargez la page.`,
    });
  }
  if (d.permissions.all) out.push({ level: 'ok', text: 'Boo Notes est autorisé sur tous les sites.' });
  else if (!d.permissions.site) out.push({ level: 'warn', text: 'Ce site n’est pas « toujours actif » : Boo Notes ne démarre qu’au clic sur son icône (ou Alt+Maj+N), et doit être relancé après chaque rechargement.' });

  const media = d.frames.flatMap((p) => p.media.map((m) => ({ ...m, frame: p })));
  const videos = media.filter((m) => m.tag === 'video' && m.width * m.height >= 160 * 90);
  if (c?.source === 'element' || c?.source === 'frame') {
    out.push({ level: 'ok', text: `Vidéo suivie${c.source === 'frame' ? ' dans un cadre (lecteur intégré)' : ''} : horodatages, captures et passages disponibles.` });
  } else if (videos.length) {
    out.push({ level: 'warn', text: `${videos.length} vidéo${videos.length > 1 ? 's' : ''} trouvée${videos.length > 1 ? 's' : ''} dans la page mais pas suivie${videos.length > 1 ? 's' : ''} : lancez la lecture, puis rouvrez les notes.` });
  } else if (!unread.length) {
    const module = [...d.frames].sort((a, b) => b.textLength - a.textLength).find((p) => !p.top && p.textLength > 200);
    const blocks = d.frames.reduce((n, p) => n + (p.videoBlocks ?? 0), 0);
    if (blocks) {
      out.push({
        level: 'warn',
        text: `${blocks} bloc${blocks > 1 ? 's' : ''} vidéo dans la leçon, pas encore chargé${blocks > 1 ? 's' : ''} (image d’aperçu) : cliquez lecture sur la vidéo — Boo Notes la suit dès qu’elle démarre — puis, au besoin, refaites le diagnostic.`,
      });
    }
    out.push({
      level: module ? 'ok' : 'warn',
      text: module
        ? `La partie affichée de la leçon${module.tool ? ` (module ${module.tool})` : ''} ne contient ni vidéo ni audio — ${module.textLength.toLocaleString('fr-FR')} caractères de texte : Boo Notes la suit comme un cours à lire. Sélectionnez un passage puis « Citer » (ou Alt+Maj+T), Alt+Maj+T sans sélection ancre la note au titre lu, Alt+Maj+S capture le module. Une vidéo lancée plus loin dans la leçon est suivie dès qu’elle démarre.`
        : 'Aucune vidéo ni aucun audio dans les parties lisibles de la page : la leçon est lue comme une page (citations, ancres, captures). Si la vidéo n’a pas encore démarré, lancez-la ; sinon le « Chronomètre » du panneau horodate quand même.',
    });
  }
  if (media.some((m) => m.drm)) out.push({ level: 'warn', text: 'Vidéo protégée (DRM) : les captures sont noires ; horodatages et passages fonctionnent.' });

  const scorm = d.frames.find((p) => p.scorm?.api12 || p.scorm?.api2004 || p.scorm?.parent === 'found');
  if (c?.scorm) out.push({ level: 'ok', text: `Module SCORM ${c.scorm.version} suivi : ${c.scorm.status || 'état inconnu'}${c.scorm.progress !== null ? ` · ${Math.round(c.scorm.progress * 100)} %` : ''}.` });
  else if (scorm) out.push({ level: 'ok', text: 'Interface SCORM du LMS trouvée : la progression s’affichera quand le module la déclarera.' });

  if (d.frames.some((p) => !p.top && !p.agent) && c) {
    out.push({ level: 'warn', text: 'Des cadres lisibles n’ont pas encore l’agent Boo Notes (cadres chargés après son démarrage) : rouvrez les notes, ou rechargez la page.' });
  }
  if (/erreur|error|refus|failed/i.test(d.sync.notion)) out.push({ level: 'error', text: `Notion : ${d.sync.notion}` });
  for (const e of c?.errors ?? []) out.push({ level: 'warn', text: `Message récent : ${e}` });
  return out;
}

/** The report as text, to paste in a message. */
export function reportText(d: Diagnostic): string {
  const lines: string[] = [];
  const mark = { ok: '✓', warn: '!', error: '✗' } as const;
  lines.push(`Diagnostic Boo Notes ${d.version} — ${new Date(d.at).toISOString()}`);
  lines.push(`Navigateur : ${d.browser}`);
  lines.push(`Page : ${d.tab.url}${d.tab.title ? ` — « ${d.tab.title} »` : ''}`);
  lines.push(`Droits : ce site ${d.permissions.site ? 'oui' : 'non'} · tous les sites ${d.permissions.all ? 'oui' : 'non'}`);
  lines.push('', 'Constat :');
  for (const f of findings(d)) lines.push(`${mark[f.level]} ${f.text}`);
  const c = d.content;
  lines.push('', 'Boo Notes dans la page :');
  if (!c) lines.push(`  absent${d.injectError ? ` (${d.injectError})` : ''}`);
  else {
    lines.push(`  note ${c.context?.noteId ?? '—'} · mode ${c.mode} · source ${c.source ?? 'aucune'} · cadres avec média ${c.mediaFrames} · module suivi ${c.moduleFollowed ? 'oui' : 'non'}`);
    if (c.panel) {
      lines.push(
        `  panneau : ${c.notesOpen ? 'ouvert' : c.popout ? 'fenêtre à part' : 'fermé'} · chargé ${c.panel.loaded ? 'oui' : 'non'} · ${c.panel.coveredBy ? `recouvert par ${c.panel.coveredBy}` : 'visible'}${c.panel.layer ? ` · placé dans ${c.panel.layer}` : ''}${c.panel.fullscreen ? ` · plein écran ${c.panel.fullscreen}` : ''}`,
      );
    }
    if (c.media) lines.push(`  média : ${c.media.tag} ${c.media.width}×${c.media.height} · ${c.media.duration} s${c.media.drm ? ' · DRM' : ''}`);
    if (c.blocked.length) lines.push(`  cadres à autoriser : ${c.blocked.join(', ')}`);
    if (c.scorm) lines.push(`  SCORM ${c.scorm.version} : ${c.scorm.status} · progression ${c.scorm.progress ?? '—'} · score ${c.scorm.score ?? '—'}`);
  }
  lines.push('', `Cadres lisibles (${d.frames.length}) :`);
  for (const p of d.frames) {
    const scorm = p.scorm ? ` · SCORM ${p.scorm.api2004 ? '2004' : p.scorm.api12 ? '1.2' : p.scorm.parent === 'found' ? 'parent' : p.scorm.parent === 'cross-origin' ? 'parent ?' : 'non'}` : '';
    lines.push(
      `- #${p.frameId} ${p.top ? '[page] ' : ''}${p.url}${p.agent || p.app ? ' · Boo Notes ✓' : ' · Boo Notes absent'}${scorm}${p.bridge ? ' · pont média ✓' : ''} · texte ${p.textLength} car.${p.tool ? ` · ${p.tool}` : ''}${p.videoBlocks ? ` · blocs vidéo non chargés ${p.videoBlocks}` : ''}`,
    );
    for (const m of p.media) lines.push(`    ${m.tag} ${m.width}×${m.height} · ${m.src || 'sans source'} · état ${m.readyState}${m.paused ? ' · en pause' : ' · lecture'}${m.duration !== null ? ` · ${m.duration} s` : ''}${m.drm ? ' · DRM' : ''}`);
    for (const f of p.frames) lines.push(`    cadre ${f.width}×${f.height} · ${f.src}${f.reachable ? ' · même site' : ''}${f.sandbox !== null ? ` · sandbox="${f.sandbox}"` : ''}${f.allow ? ` · allow="${f.allow}"` : ''}`);
  }
  lines.push('', `Synchronisation : Desktop ${d.sync.desktop} · Notion ${d.sync.notion}`);
  return lines.join('\n');
}
