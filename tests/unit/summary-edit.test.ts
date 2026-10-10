import { describe, expect, it } from 'vitest';
import { cleanPlan } from '../../src/summary/edit';
import { lessonDocument, lessonMarkdown, type PlanNode } from '../../src/shared/summary';

describe('résumé modifié à la main', () => {
  it('garde le plan tel que choisi : textes nettoyés, points et parties vides retirés, sortes et commandes gardées', () => {
    const plan: PlanNode[] = [
      {
        title: '  Le journal  ',
        at: 130,
        intro: ' Un registre ordonné. ',
        children: [
          { title: 'Un commit', at: 160, children: [], detail: ' Un fichier JSON. ', kind: 'key' },
          { title: '', at: null, children: [], detail: '', kind: 'point' },
          { title: '', at: 200, children: [], detail: 'La table rejouée. Dans l’ordre.', kind: 'definition' },
          { title: 'Historique', at: 280, children: [], detail: 'Chaque version.', kind: 'example', code: '  DESCRIBE HISTORY t;  ' },
        ],
      },
      { title: '', at: null, intro: '', children: [] },
      { title: 'Ancien format', at: 0, children: [{ title: 'Un titre seul', at: 5, children: [] }] },
    ];
    expect(cleanPlan(plan)).toEqual([
      {
        title: 'Le journal',
        at: 130,
        intro: 'Un registre ordonné.',
        children: [
          { title: 'Un commit', at: 160, children: [], detail: 'Un fichier JSON.', kind: 'key' },
          { title: 'La table rejouée', at: 200, children: [], detail: 'La table rejouée. Dans l’ordre.', kind: 'definition' },
          { title: 'Historique', at: 280, children: [], detail: 'Chaque version.', kind: 'example', code: 'DESCRIBE HISTORY t;' },
        ],
      },
      { title: 'Ancien format', at: 0, children: [{ title: 'Un titre seul', at: 5, children: [] }] },
    ]);
  });

  it('dit « modifié par vous » dans la note et le PDF (plus « à vérifier »)', () => {
    const s = { problem: { text: 'P ?', at: [] }, goals: [], solution: { text: 'S.', at: [] }, plan: [] };
    expect(lessonMarkdown(s).split('\n')[0]).toBe('> [!summary] Résumé de la leçon · IA d’après la transcription, à vérifier');
    expect(lessonMarkdown({ ...s, edited: 1 }).split('\n')[0]).toBe('> [!summary] Résumé de la leçon · IA d’après la transcription, modifié par vous');
    expect(lessonDocument({ ...s, edited: 1 })).toMatch(/^\*Généré par IA d’après la transcription, puis modifié par vous\.\*/);
  });
});
