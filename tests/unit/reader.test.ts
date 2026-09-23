// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { buildTextIndex, findPassages, linkLabel, squash } from '../../src/content/reader';
import { parseTextFragment, textFragmentUrl } from '../../src/shared/markdown';

describe('reading mode: passages of a page', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <h2>La loi d’Ohm</h2>
      <p>La tension <b>U</b> aux bornes d’un conducteur est <em>proportionnelle</em>
         à l’intensité du courant qui le traverse.</p>
      <script>var ignored = "La loi d’Ohm";</script>
      <p>On note U = R × I, avec R la résistance.</p>
      <aside id="own">La loi d’Ohm (dans Boo Notes)</aside>`;
  });

  it('ignores whitespace, case and inline tags', () => {
    expect(squash(' La  Loi\nd’Ohm ')).toBe('laloid’ohm');
    const index = buildTextIndex(document.body);
    const [range] = findPassages(index, 'tension U aux bornes', null);
    expect(range.toString()).toBe('tension U aux bornes');
  });

  it('finds a passage from its first and last words (shortened fragment)', () => {
    const quote = 'La tension U aux bornes d’un conducteur est proportionnelle à l’intensité du courant qui le traverse.';
    const frag = parseTextFragment(textFragmentUrl('https://cours.test/ohm', quote));
    expect(frag?.end).not.toBeNull();
    const [range] = findPassages(buildTextIndex(document.body), frag!.start, frag!.end);
    expect(range.toString().replace(/\s+/g, ' ')).toBe(quote);
  });

  it('skips scripts and Boo Notes’ own elements', () => {
    const own = document.getElementById('own')!;
    const index = buildTextIndex(document.body, (el) => el === own);
    const ranges = findPassages(index, 'La loi d’Ohm', null);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].startContainer.parentElement?.tagName).toBe('H2');
  });

  it('returns nothing for a passage no longer in the page', () => {
    expect(findPassages(buildTextIndex(document.body), 'loi de Kirchhoff', null)).toEqual([]);
  });

  it('makes safe link labels', () => {
    expect(linkLabel('  Chapitre [2] :\n la loi ')).toBe('Chapitre 2 : la loi');
    expect(linkLabel('x'.repeat(80))).toHaveLength(60);
  });
});
