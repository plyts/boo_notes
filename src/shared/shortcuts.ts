import type { CommandId } from './messages';

/**
 * Default shortcuts from the spec. Chrome registers them as global commands
 * when it can; it silently drops a suggested key that clashes with one of
 * its own shortcuts (Alt+Shift+T focuses the toolbar on Windows / Linux) and
 * accepts at most four defaults. Every default Chrome did not register is
 * handled in-page instead (video page + notes panel), so every shortcut
 * works out of the box. The passage keys (Alt+I / Alt+O) have no Chrome
 * default: they are in-page unless the user binds them globally.
 */
export const DEFAULT_SHORTCUTS: Readonly<Record<CommandId, string>> = {
  'toggle-sidebar': 'Alt+Shift+N',
  'insert-timestamp': 'Alt+Shift+T',
  'capture-screenshot': 'Alt+Shift+S',
  'smart-pause': 'Alt+Shift+Space',
  replay: 'Alt+Left',
  'passage-start': 'Alt+I',
  'passage-end': 'Alt+O',
};

export interface KeyCombo {
  alt: boolean;
  shift: boolean;
  ctrl: boolean;
  meta: boolean;
  /** `KeyT`, `Space`, `ArrowLeft`… (KeyboardEvent.code naming). */
  code: string;
}

const NAMED_KEYS: Record<string, string> = {
  Space: 'Space',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Comma: 'Comma',
  Period: 'Period',
  Home: 'Home',
  End: 'End',
};

export function parseShortcut(shortcut: string): KeyCombo | null {
  const parts = shortcut.split('+').map((p) => p.trim());
  const key = parts.pop();
  if (!key) return null;
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  let code: string | undefined;
  if (/^[A-Z]$/i.test(key)) code = `Key${key.toUpperCase()}`;
  else if (/^\d$/.test(key)) code = `Digit${key}`;
  else code = NAMED_KEYS[key];
  if (!code) return null;
  return {
    alt: mods.has('alt'),
    shift: mods.has('shift'),
    ctrl: mods.has('ctrl') || mods.has('macctrl'),
    meta: mods.has('command'),
    code,
  };
}

/** Layout-tolerant match: the physical key (`code`) or the produced letter (`key`). */
export function matchesCombo(
  e: Pick<KeyboardEvent, 'altKey' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'code' | 'key'>,
  combo: KeyCombo,
): boolean {
  if (e.altKey !== combo.alt || e.shiftKey !== combo.shift || e.ctrlKey !== combo.ctrl || e.metaKey !== combo.meta) {
    return false;
  }
  if (e.code === combo.code) return true;
  return combo.code.startsWith('Key') && e.key.length === 1 && e.key.toUpperCase() === combo.code.slice(3);
}

export interface InPageBinding {
  command: CommandId;
  shortcut: string;
  combo: KeyCombo;
}

/**
 * Default shortcuts to handle in the page: those with no global binding in
 * chrome://extensions/shortcuts. A command the user re-bound to another key
 * is left to Chrome.
 */
export function inPageBindings(registered: Array<{ name: string; shortcut: string }>): InPageBinding[] {
  const bound = new Map(registered.map((c) => [c.name, c.shortcut]));
  const out: InPageBinding[] = [];
  for (const [command, shortcut] of Object.entries(DEFAULT_SHORTCUTS) as Array<[CommandId, string]>) {
    if (bound.get(command)) continue;
    const combo = parseShortcut(shortcut);
    if (combo) out.push({ command, shortcut, combo });
  }
  return out;
}

export function findBinding(bindings: InPageBinding[], e: KeyboardEvent): InPageBinding | undefined {
  return bindings.find((b) => matchesCombo(e, b.combo));
}

/** `Alt+Shift+T` → `⌥⇧T` on macOS, unchanged elsewhere. */
export function formatShortcut(shortcut: string, mac: boolean): string {
  if (!mac) return shortcut.replace('Left', '←');
  return shortcut
    .replace('Alt+', '⌥')
    .replace('Shift+', '⇧')
    .replace('Ctrl+', '⌃')
    .replace('Command+', '⌘')
    .replace('Left', '←');
}
