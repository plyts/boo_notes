import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/**
 * The mouse button held down in the editor. Meanwhile the look of the lines
 * stays as it was: a line shows its Markdown (`**`, `> `, the path of a
 * picture…) once clicked, and doing it under the mouse moved the text — the
 * click, or the selection being dragged, then landed on another line.
 */

const setPressed = StateEffect.define<boolean>();

export const pointerPressed = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setPressed)) value = e.value;
    return value;
  },
});

/** Where the cursor is, as the look of the lines sees it (the lines it is on show their Markdown). */
export interface CaretView {
  hasFocus: boolean;
  ranges: ReadonlyArray<{ from: number; to: number }>;
}

/**
 * The cursor for the look of the lines: the real one, except while the mouse
 * button is down — then the one before the press (moved along with the text
 * if it changes meanwhile). `snapshot` keeps it between updates.
 */
export class CaretSnapshot {
  private last: CaretView | null = null;

  of(view: EditorView, changes?: { mapPos(pos: number): number } | null): CaretView {
    if (view.state.field(pointerPressed, false) && this.last) {
      if (changes) this.last = { hasFocus: this.last.hasFocus, ranges: this.last.ranges.map((r) => ({ from: changes.mapPos(r.from), to: changes.mapPos(r.to) })) };
      return this.last;
    }
    this.last = { hasFocus: view.hasFocus, ranges: view.state.selection.ranges.map((r) => ({ from: r.from, to: r.to })) };
    return this.last;
  }
}

/** The look must be rebuilt: not for a click or a drag under way, at once when it ends. */
export function pressChanged(startPressed: boolean, pressed: boolean): boolean {
  return startPressed !== pressed;
}

export function pointerTracking(): Extension {
  return [
    pointerPressed,
    EditorView.domEventHandlers({
      mousedown: (e, view) => {
        if (e.button !== 0) return false;
        view.dispatch({ effects: setPressed.of(true) });
        const release = () => {
          window.removeEventListener('mouseup', release, true);
          window.removeEventListener('blur', release);
          // After the editor has handled the release (its selection set).
          setTimeout(() => {
            if (view.state.field(pointerPressed, false)) view.dispatch({ effects: setPressed.of(false) });
          });
        };
        window.addEventListener('mouseup', release, true);
        window.addEventListener('blur', release);
        return false;
      },
    }),
  ];
}
