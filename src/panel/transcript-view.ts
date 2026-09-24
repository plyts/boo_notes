import { h, icon } from '../shared/icons';
import type { CaptionState } from '../shared/messages';
import { formatTimecode } from '../shared/time';
import { coverageRatio, cueIndexAt, cuesInRange, languagesLabel, rangeLabel, type Cue, type Transcript } from '../shared/transcript';
import type { TranslateStatus } from './translator';

/**
 * The « Transcription » tab of the panel: the subtitles collected in the
 * background, following the playback like a karaoke. Each line can be
 * translated, commented, pinned into the note, or be the start / end of a
 * passage. The notes themselves are never touched from here, except through
 * an explicit pin or passage.
 */
export interface TranscriptViewHooks {
  seek(seconds: number): void;
  pin(cue: Cue): void;
  annotate(id: string, field: 'tr' | 'note', value: string): void;
  /** Passage [start, end] chosen in the list; `record`: replay it to record its extract. */
  passage(start: number, end: number, record: boolean): void;
  toggleTranslate(on: boolean): void;
  /** Pins the transcript line at the end of the note now. */
  pinTranscript(): void;
  /** Plays the kept sound of the course from `seconds`. */
  listen(seconds: number): void;
  /** Notes of the note anchored in [start, end] (passage summary). */
  notesIn(start: number, end: number): number;
  /** Adds a .vtt / .srt file as the transcript (desktop app); no button when absent. */
  importSubtitles?(): void;
}

interface Row {
  el: HTMLDivElement;
  text: HTMLParagraphElement;
  tr: HTMLParagraphElement;
  note: HTMLParagraphElement;
  listen: HTMLButtonElement;
  key: string;
}

export class TranscriptView {
  readonly el: HTMLElement;
  private readonly list: HTMLDivElement;
  private readonly labelEl: HTMLSpanElement;
  private readonly coverEl: HTMLSpanElement;
  private readonly statusEl: HTMLDivElement;
  private readonly emptyEl: HTMLDivElement;
  private readonly followButton: HTMLButtonElement;
  private readonly translateButton: HTMLButtonElement;
  private readonly searchBox: HTMLDivElement;
  private readonly searchInput: HTMLInputElement;
  private readonly bar: HTMLDivElement;
  private readonly rows = new Map<string, Row>();
  private transcript: Transcript | null = null;
  private state: CaptionState = { status: 'searching', source: null, label: '' };
  private currentId: string | null = null;
  private following = true;
  private query = '';
  private anchor: Cue | null = null;
  private selection: { start: number; end: number } | null = null;
  private coverage: Array<[number, number]> = [];
  private translating = false;
  private target = 'fr';
  private readOnly = false;
  private emptyText: string | null = null;

  constructor(private readonly hooks: TranscriptViewHooks) {
    this.labelEl = h('span', { class: 'tx-label' }, 'Transcription');
    this.coverEl = h('span', { class: 'tx-cover', hidden: true });
    this.translateButton = h(
      'button',
      { type: 'button', class: 'tx-chip tx-translate', role: 'switch', 'aria-checked': 'false' },
      icon('translate', 14),
      h('span', {}, 'Traduire en français'),
    );
    this.translateButton.addEventListener('click', () => hooks.toggleTranslate(!this.translating));
    const searchButton = h('button', { type: 'button', class: 'icon-btn', title: 'Rechercher dans la transcription', 'aria-label': 'Rechercher dans la transcription' }, icon('search'));
    searchButton.addEventListener('click', () => this.toggleSearch());
    const pinAll = h(
      'button',
      { type: 'button', class: 'icon-btn tx-pin-all', title: 'Épingler la transcription à la note (pièce jointe en fin de note)', 'aria-label': 'Épingler la transcription à la note' },
      icon('pin'),
    );
    pinAll.addEventListener('click', () => hooks.pinTranscript());
    const tools: HTMLElement[] = [searchButton, pinAll];
    if (hooks.importSubtitles) {
      const add = h(
        'button',
        { type: 'button', class: 'icon-btn tx-import-btn', title: 'Ajouter des sous-titres (.vtt, .srt)', 'aria-label': 'Ajouter des sous-titres (.vtt, .srt)' },
        icon('plus'),
      );
      add.addEventListener('click', () => hooks.importSubtitles?.());
      tools.push(add);
    }
    this.searchInput = h('input', { type: 'search', placeholder: 'Rechercher (texte, traduction, commentaires)', 'aria-label': 'Rechercher dans la transcription' });
    this.searchInput.addEventListener('input', () => {
      this.query = this.searchInput.value.trim().toLowerCase();
      this.applyFilter();
    });
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.toggleSearch(false);
      }
    });
    this.searchBox = h('div', { class: 'tx-search', hidden: true }, this.searchInput);
    this.statusEl = h('div', { class: 'tx-status', role: 'status', 'aria-live': 'polite', hidden: true });
    this.list = h('div', { class: 'tx-list', role: 'list', 'aria-label': 'Répliques de la transcription' });
    this.emptyEl = h('div', { class: 'tx-empty' });
    this.followButton = h('button', { type: 'button', class: 'tx-follow', hidden: true });
    this.followButton.addEventListener('click', () => {
      this.following = true;
      this.followButton.hidden = true;
      this.scrollToCurrent('smooth');
    });
    this.bar = h('div', { class: 'tx-bar', hidden: true, role: 'toolbar', 'aria-label': 'Passage sélectionné' });
    this.el = h(
      'section',
      { class: 'transcript', hidden: true, 'aria-label': 'Transcription' },
      h(
        'div',
        { class: 'tx-head' },
        h('div', { class: 'tx-source' }, icon('subtitles', 15), this.labelEl, this.coverEl),
        h('div', { class: 'tx-tools' }, this.translateButton, h('span', { class: 'spacer' }), ...tools),
        this.searchBox,
        this.statusEl,
      ),
      this.list,
      this.emptyEl,
      this.followButton,
      this.bar,
    );
    // The user scrolls: the list stops following the playback until asked.
    const stopFollowing = () => {
      if (!this.following || !this.currentId) return;
      this.following = false;
      this.renderFollow();
    };
    this.list.addEventListener('wheel', stopFollowing, { passive: true });
    this.list.addEventListener('touchmove', stopFollowing, { passive: true });
    this.list.addEventListener('keydown', (e) => this.onListKey(e, stopFollowing));
    this.list.addEventListener('click', (e) => this.onListClick(e));
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  show(visible: boolean): void {
    this.el.hidden = !visible;
    if (visible) requestAnimationFrame(() => this.scrollToCurrent('auto'));
  }

  focus(): void {
    (this.list.querySelector<HTMLElement>('.cue.now .cue-time') ?? this.list.querySelector<HTMLElement>('.cue-time') ?? this.translateButton).focus();
  }

  setTarget(target: string): void {
    this.target = target;
  }

  /** Message of an empty transcript, instead of the browser's (desktop app). */
  setEmptyText(text: string | null): void {
    this.emptyText = text;
    this.renderHead();
  }

  /** Look and listen only (a browser note shown in the desktop app: it is annotated in the extension). */
  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
    this.el.dataset.readonly = String(readOnly);
    this.renderHead();
  }

  set(t: Transcript | null): void {
    const other = t?.noteId !== this.transcript?.noteId;
    this.transcript = t;
    if (other) {
      this.list.replaceChildren();
      this.rows.clear();
      this.currentId = null;
      this.clearSelection();
      this.following = true;
    }
    this.renderRows();
    this.renderHead();
  }

  setState(state: CaptionState): void {
    this.state = state;
    this.renderHead();
  }

  /** Stretches of the course whose sound is kept: their lines can be listened to. */
  setCoverage(ranges: Array<[number, number]>): void {
    this.coverage = ranges;
    for (const [id, row] of this.rows) {
      const cue = this.transcript?.cues.find((c) => c.id === id);
      row.listen.hidden = !cue || !this.covered(cue.start);
    }
  }

  setTranslate(on: boolean, status: TranslateStatus): void {
    this.translating = on;
    this.translateButton.setAttribute('aria-checked', String(on));
    this.el.dataset.translate = String(on);
    const lang = this.target === 'fr' ? 'français' : this.target;
    (this.translateButton.lastElementChild as HTMLElement).textContent = `Traduire en ${lang}`;
    const text: Partial<Record<TranslateStatus['state'], string>> = {
      unsupported: 'Traduction sur l’appareil indisponible dans ce navigateur (Chrome 138+) : cliquez sous une réplique pour la traduire vous-même.',
      unavailable: 'Traduction indisponible pour cette langue : cliquez sous une réplique pour la traduire vous-même.',
      same: 'Les sous-titres sont déjà en français.',
      detecting: 'Détection de la langue…',
      error: 'Traduction interrompue : cliquez sous une réplique pour la traduire vous-même.',
    };
    let message = text[status.state] ?? '';
    if (status.state === 'downloading') message = `Téléchargement du modèle de traduction… ${Math.round(status.progress * 100)} %`;
    if (status.state === 'working') message = `Traduction sur l’appareil… ${status.done} / ${status.total}`;
    this.statusEl.textContent = message;
    this.statusEl.hidden = !message || !on;
  }

  /** Playback time: highlights the line being spoken, and keeps it in view. */
  setTime(seconds: number | null): void {
    const cues = this.transcript?.cues ?? [];
    const i = seconds === null ? -1 : cueIndexAt(cues, seconds);
    const id = i === -1 ? null : cues[i].id;
    if (id === this.currentId) return;
    if (this.currentId) {
      const prev = this.rows.get(this.currentId)?.el;
      prev?.classList.remove('now');
      prev?.removeAttribute('aria-current');
    }
    this.currentId = id;
    const row = id ? this.rows.get(id)?.el : null;
    row?.classList.add('now');
    row?.setAttribute('aria-current', 'true');
    if (this.following) this.scrollToCurrent('smooth');
    this.renderFollow();
  }

  // --- Rendering ----------------------------------------------------------------------------

  private renderHead(): void {
    const t = this.transcript;
    const count = t?.cues.length ?? 0;
    // The source names its language; the translation is shown by the switch below.
    this.labelEl.textContent = t && count ? t.label : this.state.label || 'Transcription';
    this.labelEl.title = t && count ? `${t.label} — ${languagesLabel(t)}` : '';
    const live = t && !t.complete && t.duration > 0;
    this.coverEl.hidden = !live;
    if (live) this.coverEl.textContent = `${Math.round(coverageRatio(t) * 100)} % capturé`;
    this.coverEl.title = 'Part de la vidéo regardée avec les sous-titres affichés';
    const messages: Record<CaptionState['status'], string> = {
      off: 'La transcription est désactivée dans les options de Boo Notes.',
      searching: 'Aucun sous-titre pour l’instant. Lancez la lecture : Boo Notes recopie ici les sous-titres du lecteur, ou ceux affichés à l’écran, sans toucher à vos notes.',
      'captions-off': 'Activez les sous-titres du lecteur (CC) : Boo Notes les recopie ici au fil de la lecture.',
      capturing: 'Les sous-titres affichés sont recopiés ici au fil de la lecture.',
      complete: '',
    };
    this.emptyEl.hidden = count > 0;
    const children: Node[] = [icon('subtitles', 28), h('p', {}, this.emptyText ?? (messages[this.state.status] || messages.searching))];
    if (this.hooks.importSubtitles && !this.readOnly) {
      const add = h('button', { type: 'button', class: 'btn-quiet tx-import' }, icon('plus', 15), 'Ajouter des sous-titres (.vtt, .srt)');
      add.addEventListener('click', () => this.hooks.importSubtitles?.());
      children.push(add);
    }
    this.emptyEl.replaceChildren(...children);
    this.el.dataset.status = this.state.status;
  }

  private renderRows(): void {
    const cues = this.transcript?.cues ?? [];
    const seen = new Set<string>();
    let next: Element | null = this.list.firstElementChild;
    for (const cue of cues) {
      seen.add(cue.id);
      let row = this.rows.get(cue.id);
      if (!row) {
        row = this.createRow(cue);
        this.rows.set(cue.id, row);
      }
      this.fillRow(row, cue);
      if (row.el !== next) this.list.insertBefore(row.el, next);
      else next = next.nextElementSibling;
    }
    for (const [id, row] of this.rows) {
      if (seen.has(id)) continue;
      row.el.remove();
      this.rows.delete(id);
    }
    if (this.query) this.applyFilter();
  }

  private createRow(cue: Cue): Row {
    const action = (name: 'plus' | 'comment' | 'passage' | 'volume' | 'translate', label: string, act: string) =>
      h('button', { type: 'button', class: 'cue-act', 'data-act': act, title: label, 'aria-label': label }, icon(name, 15));
    const text = h('p', { class: 'cue-text' });
    const tr = h('p', { class: 'cue-tr', 'data-act': 'tr', 'data-placeholder': 'Votre traduction…' });
    const note = h('p', { class: 'cue-note', 'data-act': 'note' });
    const listen = action('volume', 'Écouter (son conservé)', 'listen');
    const el = h(
      'div',
      { class: 'cue', role: 'listitem', 'data-id': cue.id },
      h('button', { type: 'button', class: 'cue-time', 'data-act': 'seek', title: 'Aller à ce moment (Maj+clic : fin du passage)' }),
      h('div', { class: 'cue-body' }, text, tr, note),
      h(
        'div',
        { class: 'cue-actions' },
        action('plus', 'Épingler dans la note', 'pin'),
        action('translate', 'Traduire', 'translate'),
        action('comment', 'Commenter', 'comment'),
        action('passage', 'Début / fin d’un passage', 'passage'),
        listen,
      ),
    );
    return { el, text, tr, note, listen, key: '' };
  }

  private fillRow(row: Row, cue: Cue): void {
    const key = `${cue.start}|${cue.text}|${cue.tr ?? ''}|${cue.note ?? ''}`;
    if (key === row.key) return;
    row.key = key;
    (row.el.firstElementChild as HTMLElement).textContent = formatTimecode(cue.start);
    row.text.textContent = cue.text;
    if (row.tr.contentEditable !== 'plaintext-only') row.tr.textContent = cue.tr ?? '';
    row.tr.classList.toggle('empty', !cue.tr);
    if (!row.note.querySelector('textarea')) row.note.textContent = cue.note ?? '';
    row.note.hidden = !cue.note;
    row.listen.hidden = !this.covered(cue.start);
    row.el.dataset.start = String(cue.start);
  }

  private covered(t: number): boolean {
    return this.coverage.some(([a, b]) => t >= a && t < b);
  }

  private applyFilter(): void {
    const q = this.query;
    for (const [id, row] of this.rows) {
      const cue = this.transcript?.cues.find((c) => c.id === id);
      const hay = `${cue?.text ?? ''} ${cue?.tr ?? ''} ${cue?.note ?? ''}`.toLowerCase();
      row.el.hidden = Boolean(q) && !hay.includes(q);
    }
  }

  private toggleSearch(open = this.searchBox.hidden): void {
    this.searchBox.hidden = !open;
    if (open) this.searchInput.focus();
    else {
      this.searchInput.value = '';
      this.query = '';
      this.applyFilter();
    }
  }

  private scrollToCurrent(behavior: ScrollBehavior): void {
    if (this.el.hidden || !this.currentId) return;
    const row = this.rows.get(this.currentId)?.el;
    if (!row) return;
    const list = this.list.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    // Only when it leaves the comfortable middle of the list.
    if (r.top < list.top + list.height * 0.2 || r.bottom > list.bottom - list.height * 0.25) {
      this.list.scrollBy({ top: r.top - list.top - list.height * 0.3, behavior });
    }
  }

  private renderFollow(): void {
    const cue = this.currentId ? this.transcript?.cues.find((c) => c.id === this.currentId) : null;
    this.followButton.hidden = this.following || !cue;
    if (cue) this.followButton.textContent = `↓ Revenir à ${formatTimecode(cue.start)}`;
  }

  // --- Interactions ----------------------------------------------------------------------------

  private cueOf(el: Element): Cue | null {
    const id = el.closest<HTMLElement>('.cue')?.dataset.id;
    return (id && this.transcript?.cues.find((c) => c.id === id)) || null;
  }

  private onListClick(e: MouseEvent): void {
    const target = (e.target as Element).closest<HTMLElement>('[data-act]');
    if (!target) return;
    const cue = this.cueOf(target);
    if (!cue) return;
    if (this.readOnly && target.dataset.act !== 'seek' && target.dataset.act !== 'listen') return;
    switch (target.dataset.act) {
      case 'seek':
        if (e.shiftKey && this.anchor) this.select(this.anchor, cue);
        else if (e.shiftKey) this.startSelection(cue);
        else {
          this.following = true;
          this.hooks.seek(cue.start);
        }
        break;
      case 'pin':
        this.hooks.pin(cue);
        break;
      case 'comment':
        this.editNote(cue);
        break;
      case 'note':
        if (!target.querySelector('textarea')) this.editNote(cue);
        break;
      case 'tr':
        this.editTranslation(target, cue);
        break;
      case 'translate': {
        const tr = this.rows.get(cue.id)?.tr;
        if (tr) this.editTranslation(tr, cue);
        break;
      }
      case 'passage':
        if (this.anchor && this.anchor.id !== cue.id) this.select(this.anchor, cue);
        else this.startSelection(cue);
        break;
      case 'listen':
        this.hooks.listen(cue.start);
        break;
    }
  }

  private onListKey(e: KeyboardEvent, stopFollowing: () => void): void {
    if (['PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) stopFollowing();
    const time = (e.target as Element).closest('.cue-time');
    if (!time || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault();
    stopFollowing();
    let row = time.closest('.cue') as HTMLElement | null;
    do row = (e.key === 'ArrowDown' ? row?.nextElementSibling : row?.previousElementSibling) as HTMLElement | null;
    while (row && row.hidden);
    row?.querySelector<HTMLElement>('.cue-time')?.focus();
  }

  private editTranslation(el: HTMLElement, cue: Cue): void {
    if (el.contentEditable === 'plaintext-only') return;
    const before = cue.tr ?? '';
    el.contentEditable = 'plaintext-only';
    el.classList.add('editing');
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    const done = (save: boolean) => {
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('blur', onBlur);
      el.contentEditable = 'false';
      el.removeAttribute('contenteditable');
      el.classList.remove('editing');
      const value = (el.textContent ?? '').trim();
      if (save && value !== before) this.hooks.annotate(cue.id, 'tr', value);
      else el.textContent = before;
      el.classList.toggle('empty', !(save ? value : before));
    };
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        done(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        done(false);
      }
    };
    const onBlur = () => done(true);
    el.addEventListener('keydown', onKey);
    el.addEventListener('blur', onBlur);
  }

  private editNote(cue: Cue): void {
    const row = this.rows.get(cue.id);
    if (!row || row.note.querySelector('textarea')) return;
    const area = h('textarea', { rows: '2', placeholder: 'Votre commentaire… (Entrée pour valider, Échap pour annuler)', 'aria-label': `Commentaire sur ${formatTimecode(cue.start)}` });
    area.value = cue.note ?? '';
    row.note.hidden = false;
    row.note.replaceChildren(area);
    area.focus();
    let closed = false;
    const done = (save: boolean) => {
      if (closed) return;
      closed = true;
      const value = area.value.trim();
      row.note.replaceChildren(save ? value : (cue.note ?? ''));
      row.note.hidden = !(save ? value : cue.note);
      if (save && value !== (cue.note ?? '')) this.hooks.annotate(cue.id, 'note', value);
    };
    area.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        done(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        done(false);
      }
    });
    area.addEventListener('blur', () => done(true));
  }

  private startSelection(cue: Cue): void {
    this.anchor = cue;
    this.selection = null;
    this.markSelected(cue.start, cue.end);
    this.renderBar(`Début du passage : ${formatTimecode(cue.start)}. Choisissez la fin (⧗ ou Maj+clic sur une autre réplique).`);
  }

  private select(a: Cue, b: Cue): void {
    const start = Math.min(a.start, b.start);
    const end = Math.max(a.end, b.end);
    this.selection = { start, end };
    this.markSelected(start, end);
    const cues = cuesInRange(this.transcript?.cues ?? [], start, end).length;
    const notes = this.hooks.notesIn(start, end);
    const summary = `Passage ${rangeLabel(start, end)} · ${cues} réplique${cues > 1 ? 's' : ''}${notes ? ` · ${notes} note${notes > 1 ? 's' : ''}` : ''}`;
    this.renderBar(summary, true);
  }

  private markSelected(start: number, end: number): void {
    for (const [id, row] of this.rows) {
      const cue = this.transcript?.cues.find((c) => c.id === id);
      row.el.classList.toggle('selected', Boolean(cue && cue.start >= start && cue.start < end + 0.01));
    }
  }

  private renderBar(text: string, ready = false): void {
    const cancel = h('button', { type: 'button', class: 'btn-quiet' }, 'Annuler');
    cancel.addEventListener('click', () => this.clearSelection());
    const children: Node[] = [h('span', { class: 'tx-bar-text' }, text)];
    if (ready) {
      const record = h('input', { type: 'checkbox', checked: true });
      const create = h('button', { type: 'button', class: 'btn-primary' }, icon('passage', 15), 'Créer le passage');
      create.addEventListener('click', () => {
        const s = this.selection;
        if (!s) return;
        this.hooks.passage(s.start, s.end, record.checked);
        this.clearSelection();
      });
      children.push(
        h('label', { class: 'tx-bar-record', title: 'Rejoue le passage pour enregistrer son image et son son ; vous continuez d’écrire pendant ce temps' }, record, 'Enregistrer l’extrait'),
        h('div', { class: 'tx-bar-actions' }, cancel, create),
      );
    } else children.push(h('div', { class: 'tx-bar-actions' }, cancel));
    this.bar.replaceChildren(...children);
    this.bar.hidden = false;
  }

  clearSelection(): void {
    this.anchor = null;
    this.selection = null;
    this.bar.hidden = true;
    for (const row of this.rows.values()) row.el.classList.remove('selected');
  }
}
