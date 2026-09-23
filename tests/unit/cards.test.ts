import { describe, expect, it } from 'vitest';
import { extractCards } from '../../src/shared/cards';

describe('cartes de révision', () => {
  it('ignores the anchor that starts a note line', () => {
    const cards = extractCards('n', '[p. 1] U = R × I :: loi d’Ohm\n- [04:15](res:file:1) τ = R × C :: constante de temps\n[pin 2] La ==membrane== est semi-perméable');
    expect(cards.map((c) => [c.type, c.front, c.back])).toEqual([
      ['basic', 'U = R × I', 'loi d’Ohm'],
      ['basic', 'τ = R × C', 'constante de temps'],
      ['cloze', 'La {{c1::membrane}} est semi-perméable', ''],
    ]);
  });
});
