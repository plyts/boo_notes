import { NotesEditor } from '../../../src/panel/editor';
import { findAssetRefs, findPageRefs, findTimestamps } from '../../../src/shared/markdown';
import type { ItemView } from '../ipc';
import { errorMessage, h, icon, toast } from './ui';

export interface NotesPaneOptions {
  item: ItemView;
  readOnly: boolean;
  /** Token prefixed to new lines (`[04:15]`, `[p. 12]`), or null for none. */
  stamp(): string | null;
  now(): number | null;
  onTimestampClick(seconds: number): void;
  onTimestampHover?(seconds: number | null): void;
  onPageRefClick?(page: number): void;
  onKeystroke?(): void;
  onContentChanged?(markdown: string): void;
}

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

/** The note of the item: live-preview Markdown editor with autosave. */
export class NotesPane {
  readonly el: HTMLElement;
  readonly editor: NotesEditor;
  private readonly statsEl: HTMLElement;
  private readonly saveEl: HTMLElement;
  private readonly footer: HTMLElement;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private state: SaveState = 'idle';

  constructor(private readonly opts: NotesPaneOptions) {
    this.statsEl = h('span', { class: 'notes-stats' });
    this.saveEl = h('span', { class: 'save-state', role: 'status', 'aria-live': 'polite' });
    const editorHost = h('div', { class: 'notes-editor', 'aria-label': 'Notes (Markdown)' });
    this.footer = h('div', { class: 'notes-footer' });
    this.el = h(
      'section',
      { class: 'notes-pane', 'aria-label': 'Notes' },
      h(
        'header',
        { class: 'notes-head' },
        h('h2', {}, 'Notes'),
        this.statsEl,
        h('span', { class: 'spacer' }),
        opts.readOnly ? h('span', { class: 'readonly-chip', title: 'Cette note s’écrit dans l’extension du navigateur' }, icon('globe', 13), 'Navigateur') : this.saveEl,
      ),
      editorHost,
      this.footer,
    );
    this.editor = new NotesEditor(editorHost, {
      now: () => opts.now(),
      autoTimestamp: () => !opts.readOnly,
      stampToken: () => opts.stamp(),
      onTimestampHover: (s) => opts.onTimestampHover?.(s),
      onTimestampClick: (s) => opts.onTimestampClick(s),
      onPageRefClick: (p) => opts.onPageRefClick?.(p),
      onKeystroke: () => opts.onKeystroke?.(),
      onChange: () => this.scheduleSave(),
      onContentChanged: () => this.renderStats(),
      onSaveShortcut: () => void this.flush(),
      onHelp: () => undefined,
      loadAsset: async (path) => `boo://app/__vault/${path.split('/').map(encodeURIComponent).join('/')}`,
    });
    if (opts.readOnly) this.editor.setEditable(false);
    this.renderSave();
  }

  /** Buttons shown under the editor (stamp, capture, quote…). */
  setActions(...nodes: Node[]): void {
    this.footer.replaceChildren(...nodes);
    this.footer.hidden = nodes.length === 0;
  }

  load(markdown: string): void {
    this.editor.load(markdown);
    this.state = 'idle';
    this.renderSave();
  }

  /** Insert a stamp (`[p. 3]`, `[04:15]`) on a new line, focusing the editor. */
  stampLine(token: string): void {
    if (this.opts.readOnly) return;
    this.editor.focus('end');
    this.editor.insertToken(token, true);
  }

  insertBlock(text: string, at: 'cursor' | 'end' = 'cursor'): void {
    if (this.opts.readOnly) return;
    this.editor.insertBlock(text, at);
  }

  focus(): void {
    this.editor.focus('keep');
  }

  /** Writes pending changes now (before leaving the item). */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.save();
    }
    await this.saving;
  }

  private scheduleSave(): void {
    if (this.opts.readOnly) return;
    this.state = 'dirty';
    this.renderSave();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 600);
  }

  private save(): void {
    const markdown = this.editor.content;
    this.state = 'saving';
    this.renderSave();
    this.saving = this.saving
      .then(() => window.boo.library.saveNote(this.opts.item.id, markdown))
      .then(
        () => {
          if (this.state === 'saving') this.state = 'saved';
          this.renderSave();
        },
        (e: unknown) => {
          this.state = 'error';
          this.renderSave();
          toast(`Note non enregistrée : ${errorMessage(e)}`, 'error');
        },
      );
  }

  private renderSave(): void {
    const labels: Record<SaveState, string> = {
      idle: 'Enregistré',
      dirty: 'Modifié',
      saving: 'Enregistrement…',
      saved: 'Enregistré',
      error: 'Erreur d’enregistrement',
    };
    this.saveEl.textContent = labels[this.state];
    this.saveEl.dataset.state = this.state;
  }

  private renderStats(): void {
    const md = this.editor.content;
    const notes = findTimestamps(md).length + findPageRefs(md).length;
    const captures = findAssetRefs(md).length;
    const parts = [
      notes ? `${notes} note${notes > 1 ? 's' : ''}` : '',
      captures ? `${captures} capture${captures > 1 ? 's' : ''}` : '',
    ].filter(Boolean);
    this.statsEl.textContent = parts.join(' · ');
    this.opts.onContentChanged?.(md);
  }
}
