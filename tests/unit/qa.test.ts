import { describe, expect, it } from 'vitest';
import {
  buildPrompt,
  clip,
  extracts,
  forPrompt,
  notePassages,
  pagePassages,
  parseAnswer,
  rank,
  sourceOf,
  transcriptPassages,
  words,
} from '../../src/shared/qa';
import type { Cue } from '../../src/shared/transcript';

const cue = (start: number, text: string, tr?: string): Cue => ({ id: `c${start}`, start, end: start + 4, text, ...(tr ? { tr } : {}) });

const cues: Cue[] = [
  cue(0, 'Welcome to this lesson about deployment.'),
  cue(5, 'Today we look at agents.'),
  cue(50, 'Model Serving deploys the agent behind a REST endpoint.', 'Model Serving déploie l’agent derrière un point de terminaison REST.'),
  cue(55, 'It scales automatically with the traffic.'),
  cue(120, 'Monitoring collects every request in an inference table.', 'La surveillance enregistre chaque requête dans une table d’inférence.'),
  cue(1421, 'This method works because the gradients stay bounded.'),
];

describe('words', () => {
  it('folds case, accents, small words and plurals', () => {
    expect(words('Pourquoi les Méthodes fonctionnent-elles ?')).toEqual(['methode', 'fonctionnent']);
    expect(words("l'approche")).toEqual(['approche']);
  });

  it('clips at a word', () => {
    expect(clip('un deux trois quatre cinq', 14)).toBe('un deux trois…');
    expect(clip('court', 14)).toBe('court');
  });
});

describe('passages', () => {
  it('cuts the transcript in passages of about 40 s, each with its moment', () => {
    const ps = transcriptPassages(cues);
    expect(ps.map((p) => [p.id, p.start, p.ref])).toEqual([
      ['T1', 0, '[00:00]'],
      ['T2', 50, '[00:50]'],
      ['T3', 120, '[02:00]'],
      ['T4', 1421, '[23:41]'],
    ]);
    // The translation is searched too.
    expect(ps[1].text).toContain('point de terminaison');
    expect(ps[1].display).not.toContain('point de terminaison');
  });

  it('cuts the page by sections, linked to the passage', () => {
    const [p] = pagePassages([{ heading: 'Déployer un agent', text: 'Un agent se déploie avec Model Serving. Il répond par une API REST.' }], 'https://c.test/lesson');
    expect(p.id).toBe('P1');
    expect(p.ref).toMatch(/^\[↗ Déployer un agent\]\(https:\/\/c\.test\/lesson#:~:text=/);
  });

  it('takes the notes already written, not the questions nor the pictures', () => {
    const ps = notePassages(
      [
        { title: null, lines: ['[00:52] Model Serving : endpoint REST', '> [!question] Question 1', '> Pourquoi ?', '[01:00] ![Capture](assets/a.png)'] },
        { title: 'Leçon 1', lines: ['Les agents appellent des outils.'] },
      ],
      (n, l) => n === 0 && (l === 1 || l === 2),
    );
    expect(ps.map((p) => [p.ref, p.display])).toEqual([
      ['[00:52]', 'Model Serving : endpoint REST'],
      ['[[Leçon 1]]', 'Les agents appellent des outils.'],
    ]);
  });
});

describe('ranking', () => {
  const all = [...transcriptPassages(cues), ...pagePassages([{ heading: 'Monitoring', text: 'Inference tables keep the requests and the responses of an endpoint.' }], 'https://c.test/l')];

  it('finds the passage that answers, in either language', () => {
    expect(rank('How is the agent deployed behind an endpoint?', all)[0].passage.id).toBe('T2');
    // A French question finds the subtitle through its translation.
    expect(rank('Comment l’agent est-il déployé derrière un point de terminaison ?', all)[0].passage.id).toBe('T2');
    // Words added by a translation of the question.
    expect(rank('Où vont les requêtes ?', all, { extra: 'Where do the requests go? inference table' })[0].passage.id).toMatch(/^(T3|P1)$/);
  });

  it('what was said just before the question counts more', () => {
    const twice = transcriptPassages([cue(0, 'The endpoint returns a response.'), cue(300, 'The endpoint returns a response.')]);
    expect(rank('endpoint response', twice, { stamp: 310 })[0].passage.id).toBe('T2');
    expect(rank('endpoint response', twice, { stamp: 8 })[0].passage.id).toBe('T1');
  });

  it('keeps the closest passages when no AI answers', () => {
    const r = rank('Why does this method work? gradients', all);
    expect(extracts(r).map((p) => p.id)).toEqual(['T4']);
    expect(extracts([])).toEqual([]);
  });

  it('a source points at the subtitle where the quote starts', () => {
    const [, t2] = transcriptPassages(cues);
    expect(sourceOf(t2, 'It scales automatically')).toEqual({ kind: 'transcript', ref: '[00:55]', quote: 'It scales automatically' });
    // A quote the passage does not hold: the passage itself is quoted.
    expect(sourceOf(t2, 'invented words').quote).toContain('Model Serving deploys');
  });
});

describe('the AI', () => {
  const ps = transcriptPassages(cues);

  it('gives every passage while they fit, the best ones (and their neighbours) otherwise', () => {
    expect(forPrompt(ps, [], 100_000)).toHaveLength(4);
    const r = rank('gradients method', ps);
    expect(forPrompt(ps, r, 150).map((p) => p.id)).toEqual(['T4']);
  });

  it('asks in French, with the moment of the question and the passages by id', () => {
    const { system, user } = buildPrompt('Pourquoi ?', ps.slice(0, 2), { title: 'Agents', stamp: 125 });
    expect(system).toContain('JSON');
    expect(user).toContain('Question posée à 02:05');
    expect(user).toContain('[T2] 00:50–00:59 : Model Serving deploys');
  });

  it('reads the answer and keeps only the sources it was given', () => {
    const reply = 'Voici : {"answer": "Parce que les gradients restent bornés.", "found": true, "sources": [{"id": "T4", "quote": "the gradients stay bounded"}, {"id": "T99", "quote": "x"}]}';
    expect(parseAnswer(reply, ps)).toEqual({
      answer: 'Parce que les gradients restent bornés.',
      found: true,
      sources: [{ kind: 'transcript', ref: '[23:41]', quote: 'the gradients stay bounded' }],
    });
    expect(parseAnswer('Pas de JSON ici.', ps)).toEqual({ answer: 'Pas de JSON ici.', found: true, sources: [] });
    expect(parseAnswer('{"answer": "Le cours n’en parle pas.", "found": false, "sources": []}', ps).found).toBe(false);
  });
});
