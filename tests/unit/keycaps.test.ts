import { describe, expect, it } from 'vitest';
import { shortcutKeys } from '../../src/shared/keycaps';

describe('shortcutKeys', () => {
  it('splits Chrome shortcut strings', () => {
    expect(shortcutKeys('Alt+Shift+T', false)).toEqual(['Alt', 'Shift', 'T']);
    expect(shortcutKeys('Alt+Shift+Space', false)).toEqual(['Alt', 'Shift', 'Espace']);
    expect(shortcutKeys('Alt+Left', false)).toEqual(['Alt', '←']);
  });
  it('uses macOS symbols', () => {
    expect(shortcutKeys('Alt+Shift+T', true)).toEqual(['⌥', '⇧', 'T']);
    // Chrome already formats macOS shortcuts as symbols.
    expect(shortcutKeys('⌥⇧S', true)).toEqual(['⌥', '⇧', 'S']);
  });
  it('keeps named keys whole', () => {
    expect(shortcutKeys('Entrée', false)).toEqual(['Entrée']);
    expect(shortcutKeys('Alt+Clic', true)).toEqual(['⌥', 'Clic']);
  });
  it('handles unset shortcuts', () => {
    expect(shortcutKeys('', false)).toEqual([]);
  });
});
