import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * WCAG 2.2 contrast check of the design tokens (src/tokens.css), for both
 * themes: 4.5:1 for text, 3:1 for UI components / focus indicators.
 */
const css = readFileSync(new URL('../../src/tokens.css', import.meta.url), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

type RGBA = [number, number, number, number];

function parse(color: string): RGBA {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgba = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(color);
  if (rgba) return [+rgba[1], +rgba[2], +rgba[3], rgba[4] === undefined ? 1 : +rgba[4]];
  throw new Error(`unsupported colour ${color}`);
}

function over(fg: RGBA, bg: RGBA): RGBA {
  const a = fg[3];
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
}

function luminance([r, g, b]: RGBA): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function ratio(a: RGBA, b: RGBA): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// [foreground, background layers (bottom → top), minimum ratio]
const PAIRS: Array<[string, string[], number]> = [
  ['text', ['bg'], 4.5],
  ['text', ['surface'], 4.5],
  ['text', ['surface-2'], 4.5],
  ['text', ['elevated'], 4.5],
  ['text', ['kbd-bg'], 4.5],
  ['muted', ['elevated'], 4.5],
  ['ok', ['surface'], 3],
  ['warn', ['surface'], 3],
  ['muted', ['bg'], 4.5],
  ['muted', ['surface'], 4.5],
  ['faint', ['bg'], 4.5],
  ['faint', ['surface'], 4.5],
  ['accent', ['bg'], 4.5],
  ['accent', ['surface'], 4.5],
  ['ts-text', ['bg', 'ts-bg'], 4.5],
  ['ts-text', ['now-bg', 'ts-bg'], 4.5],
  ['text', ['now-bg'], 4.5],
  ['on-accent', ['accent-strong'], 4.5],
  ['danger', ['bg'], 4.5],
  ['focus', ['bg'], 3],
  ['now-border', ['bg'], 3],
  ['ok', ['bg'], 3],
  ['warn', ['bg'], 3],
];

describe.each([
  ['dark', ":root,\n[data-theme='dark']"],
  ['light', "[data-theme='light']"],
])('%s theme', (_name, selector) => {
  const tokens = block(selector);
  it.each(PAIRS)('%s on %j ≥ %d:1', (fg, layers, min) => {
    const bg = layers.map((l) => parse(tokens[l])).reduce((acc, layer) => over(layer, acc));
    expect(ratio(over(parse(tokens[fg]), bg), bg)).toBeGreaterThanOrEqual(min);
  });
});
