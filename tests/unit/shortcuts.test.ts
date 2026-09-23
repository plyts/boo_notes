import { describe, expect, it } from 'vitest';
import { DEFAULT_SHORTCUTS, formatShortcut, inPageBindings, matchesCombo, parseShortcut } from '../../src/shared/shortcuts';

const key = (init: Partial<KeyboardEvent>) => ({ altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, code: '', key: '', ...init });

describe('parseShortcut / matchesCombo', () => {
  it('parses Chrome shortcut strings', () => {
    expect(parseShortcut('Alt+Shift+T')).toEqual({ alt: true, shift: true, ctrl: false, meta: false, code: 'KeyT' });
    expect(parseShortcut('Alt+Shift+Space')?.code).toBe('Space');
    expect(parseShortcut('Alt+Left')?.code).toBe('ArrowLeft');
    expect(parseShortcut('Alt+Shift+?')).toBeNull();
  });

  it('matches by physical key or produced letter, with exact modifiers', () => {
    const combo = parseShortcut('Alt+Shift+T');
    if (!combo) throw new Error('parse');
    expect(matchesCombo(key({ altKey: true, shiftKey: true, code: 'KeyT', key: 'T' }), combo)).toBe(true);
    // Another layout: letter T on a different physical key.
    expect(matchesCombo(key({ altKey: true, shiftKey: true, code: 'KeyK', key: 't' }), combo)).toBe(true);
    // macOS Option produces a special character but keeps the code.
    expect(matchesCombo(key({ altKey: true, shiftKey: true, code: 'KeyT', key: 'ˇ' }), combo)).toBe(true);
    expect(matchesCombo(key({ altKey: true, code: 'KeyT', key: 't' }), combo)).toBe(false);
    expect(matchesCombo(key({ altKey: true, shiftKey: true, ctrlKey: true, code: 'KeyT', key: 'T' }), combo)).toBe(false);
  });
});

describe('inPageBindings', () => {
  it('keeps only the defaults Chrome did not register', () => {
    const registered = [
      { name: 'toggle-sidebar', shortcut: 'Alt+Shift+N' },
      { name: 'insert-timestamp', shortcut: '' }, // dropped by Chrome (conflict)
      { name: 'capture-screenshot', shortcut: 'Alt+Shift+S' },
      { name: 'smart-pause', shortcut: 'Alt+Shift+Space' },
      { name: 'replay', shortcut: '' }, // no default: over Chrome's limit of four
    ];
    expect(inPageBindings(registered).map((b) => b.command)).toEqual(['insert-timestamp', 'replay']);
  });

  it('leaves re-bound commands to Chrome', () => {
    expect(inPageBindings([{ name: 'replay', shortcut: 'Ctrl+Shift+Left' }]).map((b) => b.command)).not.toContain('replay');
  });

  it('covers every command of the spec', () => {
    expect(Object.keys(DEFAULT_SHORTCUTS)).toHaveLength(5);
  });
});

describe('formatShortcut', () => {
  it('uses symbols on macOS', () => {
    expect(formatShortcut('Alt+Shift+T', true)).toBe('⌥⇧T');
    expect(formatShortcut('Alt+Left', false)).toBe('Alt+←');
  });
});
