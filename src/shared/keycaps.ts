import { h } from './icons';

const MAC_SYMBOLS: Record<string, string> = {
  Alt: '⌥',
  Option: '⌥',
  Shift: '⇧',
  Ctrl: '⌃',
  MacCtrl: '⌃',
  Command: '⌘',
  Cmd: '⌘',
  Mod: '⌘',
};

const NAMES: Record<string, string> = {
  Left: '←',
  Right: '→',
  Up: '↑',
  Down: '↓',
  Space: 'Espace',
  Mod: 'Ctrl',
};

/**
 * Splits a shortcut into keys: `Alt+Shift+T` (Chrome on Windows / Linux or
 * our own defaults) as well as `⌥⇧T` (Chrome on macOS).
 */
export function shortcutKeys(shortcut: string, mac: boolean): string[] {
  if (!shortcut) return [];
  // Chrome on macOS formats shortcuts as bare symbols (`⌥⇧S`): one key per character.
  const macSymbols = !shortcut.includes('+') && /^[⌥⇧⌃⌘]+.$/u.test(shortcut);
  const parts = macSymbols ? [...shortcut] : shortcut.split('+').map((p) => p.trim());
  return parts.filter(Boolean).map((p) => (mac && MAC_SYMBOLS[p]) || NAMES[p] || p);
}

/** `<span class="keys"><kbd>⌥</kbd><kbd>⇧</kbd><kbd>T</kbd></span>` */
export function keycaps(shortcut: string, mac: boolean): HTMLSpanElement {
  const keys = shortcutKeys(shortcut, mac);
  const label = keys.join(mac ? '' : '+');
  return h('span', { class: 'keys', 'aria-label': label, title: label }, ...keys.map((k) => h('kbd', {}, k)));
}

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
