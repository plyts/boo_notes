import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiError } from '../../src/shared/ai-client';
import {
  basisOf,
  coverage,
  isStale,
  lessonMarkdown,
  lessonPrompt,
  linesOf,
  linesSize,
  parseCourse,
  parseLesson,
  partsOf,
  withSummary,
  type Line,
  type Prompt,
} from '../../src/shared/summary';
import { courseContent, staleLessons, summarizeCourse, summarizeLesson, type Writer } from '../../src/shared/summarizer';
import type { Cue, Transcript } from '../../src/shared/transcript';
import { MemoryArea } from './helpers';

afterEach(() => vi.unstubAllGlobals());

/** A transcript of `n` subtitles, one every 4 s, a sentence each. */
function transcript(n: number, extra: Partial<Transcript> = {}): Transcript {
  const cues: Cue[] = Array.from({ length: n }, (_, i) => ({ id: `q${i}`, start: i * 4, end: i * 4 + 3.5, text: `Sentence number ${i} about delta logs and commits.` }));
  return { noteId: 'n1', lang: 'en', label: 'Sous-titres', source: 'track', target: 'fr', complete: true, covered: [], duration: n * 4, cues, updatedAt: 1, rev: 1, ...extra } as Transcript;
}

/** The ids of the lines a request shows (`[c12 00:48]`). */
const idsIn = (text: string) => [...text.matchAll(/\[(c\d+) \d/g)].map((m) => m[1]);

/** A stand-in AI: replies from what it is shown, records every request. */
function fakeWriter(budget: number, opts: { tooLargeOver?: number } = {}): Writer & { asked: Prompt[] } {
  const asked: Prompt[] = [];
  return {
    provider: 'groq',
    model: 'test-model',
    label: 'Groq',
    asked,
    budget: async () => budget,
    async write(prompt) {
      asked.push(prompt);
      if (opts.tooLargeOver && prompt.user.length > opts.tooLargeOver) throw new AiError('demande trop longue pour Groq', 413, true);
      if (prompt.system.includes('lue par parties. Uniquement')) {
        const ids = idsIn(prompt.user);
        return JSON.stringify({ sections: [{ title: `Partie dès ${ids[0]}`, ref: ids[0], points: [{ title: 'Un point', ref: ids[1] ?? ids[0] }] }], ideas: [{ kind: 'problem', text: 'Le problème posé.', ref: ids[0] }] });
      }
      if (prompt.system.includes('Voici un cours entier')) {
        return JSON.stringify({
          problem: 'Comment fiabiliser un data lake ?',
          goals: [{ text: 'Comprendre le journal', chapter: '1' }],
          solution: 'Un journal de transactions.',
          chapters: [{ id: '1', synthesis: 'Les bases.' }],
          lessons: [{ id: 'L1', synthesis: 'La première leçon.' }],
        });
      }
      const ids = [...prompt.user.matchAll(/\b(c\d+)\b/g)].map((m) => m[1]);
      const first = ids[0];
      const later = ids[Math.min(ids.length - 1, 5)];
      return `Voici : \`\`\`json\n${JSON.stringify({
        problem: { text: 'Comment écrire à deux sans corrompre la table ?', refs: [first, 'c9999'] },
        goals: [{ text: 'Expliquer le journal', refs: [later] }],
        solution: { text: 'Un journal ordonné de commits.', refs: [later] },
        plan: [
          { title: 'Deuxième partie', ref: later, children: [] },
          { title: 'Première partie', ref: first, children: [{ title: 'Un point', ref: first, children: [{ title: 'Inventé', ref: 'c9999' }] }] },
        ],
      })}\n\`\`\``;
    },
  };
}

describe('résumé : la transcription lue', () => {
  it('des sous-titres regroupés en répliques (une phrase environ), chacune avec son instant', () => {
    const lines = linesOf(transcript(20).cues);
    expect(lines.length).toBeLessThan(20);
    expect(lines[0]).toMatchObject({ id: 'c0', at: 0 });
    expect(lines[1].at).toBeGreaterThan(0);
    // In parts that each fit the budget, nothing lost.
    const parts = partsOf(lines, 300);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.flat()).toEqual(lines);
    for (const p of parts) expect(linesSize(p)).toBeLessThanOrEqual(300 + 200);
  });

  it('la demande : la leçon, sa durée, chaque réplique avec son identifiant et son instant ; consignes en français', () => {
    const lines: Line[] = [{ id: 'c0', at: 0, text: 'Hello' }, { id: 'c1', at: 62, text: 'Delta log' }];
    const p = lessonPrompt({ title: 'Delta Lake', course: 'Databricks', chapter: 'Delta', duration: 768 }, lines);
    expect(p.user).toContain('Leçon : Delta Lake');
    expect(p.user).toContain('Cours : Databricks › Delta');
    expect(p.user).toContain('Durée de la vidéo : 12:48');
    expect(p.user).toContain('[c1 01:02] Delta log');
    expect(p.system).toContain('Problématique');
    expect(p.system).toContain('Objectifs');
    expect(p.system).toContain('Solution');
    expect(p.system).toContain('Plan');
    expect(p.system).toContain('n’invente rien');
  });

  it('la réponse lue : les instants cités qui n’existent pas sont écartés, le plan remis dans l’ordre de la vidéo', () => {
    const lines: Line[] = [{ id: 'c0', at: 0, text: 'a' }, { id: 'c1', at: 35, text: 'b' }, { id: 'c2', at: 130, text: 'c' }];
    const d = parseLesson(
      '{"problem":{"text":"Pourquoi ?","refs":["c1","[c2]","c77"]},"goals":[{"text":"Savoir","refs":["c2"]}],"solution":{"text":"Ainsi.","refs":["c2 02:10"]},"plan":[{"title":"B","ref":"c2","children":[]},{"title":"A","ref":"c0","children":[{"title":"A1","ref":"c1","children":[{"title":"x","ref":"c99"}]}]},],}',
      lines,
    );
    expect(d.problem).toEqual({ text: 'Pourquoi ?', at: [35, 130] });
    expect(d.solution.at).toEqual([130]);
    expect(d.plan.map((n) => n.title)).toEqual(['A', 'B']);
    expect(d.plan[0].children[0]).toMatchObject({ title: 'A1', at: 35 });
    // A detail whose moment does not exist keeps its title, without a moment.
    expect(d.plan[0].children[0].children[0]).toEqual({ title: 'x', at: null, children: [] });
    expect(() => parseLesson('rien du tout', lines)).toThrow('illisible');
    expect(() => parseLesson('{"plan":[]}', lines)).toThrow('rien résumé');
  });

  it('couverture : sous-titres complets, captés en partie, ou aucun ; résumé à mettre à jour quand la transcription change', () => {
    expect(coverage(transcript(10)).state).toBe('full');
    expect(coverage(transcript(10, { complete: false, covered: [[0, 8]], duration: 100 })).state).toBe('partial');
    expect(coverage(null).state).toBe('none');
    const t = transcript(10);
    const summary = { basis: basisOf(t) };
    expect(isStale(summary, t)).toBe(false);
    expect(isStale(summary, transcript(12))).toBe(true);
  });
});

describe('résumé : dans la note', () => {
  const draft = {
    problem: { text: 'Comment écrire à deux sans corrompre la table ?', at: [35] },
    goals: [{ text: 'Expliquer le journal', at: [130] }],
    solution: { text: 'Un journal ordonné.', at: [200] },
    plan: [{ title: 'Les limites', at: 0, children: [{ title: 'Écritures partielles', at: 48, children: [{ title: 'Fichiers orphelins', at: 50, children: [] }] }] }],
  };

  it('un bloc « Résumé » (callout), ses horodatages cliquables, le plan numéroté', () => {
    expect(lessonMarkdown(draft)).toBe(
      [
        '> [!summary] Résumé de la leçon · IA d’après la transcription, à vérifier',
        '> **Problématique —** Comment écrire à deux sans corrompre la table ? [00:35]',
        '>',
        '> **Objectifs**',
        '> - Expliquer le journal [02:10]',
        '>',
        '> **Solution —** Un journal ordonné. [03:20]',
        '>',
        '> **Plan**',
        '> 1. Les limites [00:00]',
        '>    1. Écritures partielles [00:48]',
        '>       - Fichiers orphelins [00:50]',
      ].join('\n'),
    );
  });

  it('en tête de la note ; inséré de nouveau, il remplace l’ancien sans toucher aux notes', () => {
    const notes = '[01:02] Ma note\n[03:04] Une autre';
    const once = withSummary(notes, lessonMarkdown(draft));
    expect(once.startsWith('> [!summary] Résumé de la leçon')).toBe(true);
    expect(once.endsWith('\n\n[01:02] Ma note\n[03:04] Une autre')).toBe(true);
    const twice = withSummary(once, '> [!summary] Résumé de la leçon · v2\n> **Problématique —** Autre ?');
    expect(twice).toBe('> [!summary] Résumé de la leçon · v2\n> **Problématique —** Autre ?\n\n[01:02] Ma note\n[03:04] Une autre');
    expect(withSummary('', '> [!summary] X')).toBe('> [!summary] X\n');
  });
});

describe('résumé : toute la transcription d’une leçon', () => {
  it('courte : lue en une fois', async () => {
    const w = fakeWriter(100_000);
    const s = await summarizeLesson({ noteId: 'n1', title: 'Delta', transcript: transcript(30) }, w);
    expect(w.asked).toHaveLength(1);
    expect(s).toMatchObject({ noteId: 'n1', provider: 'groq', model: 'test-model', parts: 1 });
    expect(s.problem.at).toEqual([0]);
    expect(s.plan.map((n) => n.title)).toEqual(['Première partie', 'Deuxième partie']);
    // Every line of the transcript was in the request.
    expect(idsIn(w.asked[0].user)).toHaveLength(linesOf(transcript(30).cues).length);
  });

  it('longue : lue par parties (chacune entière), puis les notes de lecture réunies ; le plan grandit pendant la lecture', async () => {
    const w = fakeWriter(1_500);
    const seen: number[] = [];
    const steps: string[] = [];
    const t = transcript(200);
    const s = await summarizeLesson({ noteId: 'n1', title: 'Delta', transcript: t }, w, { onPart: (_d, k) => seen.push(k), onStep: (st) => steps.push(st.phase) });
    const parts = w.asked.filter((p) => p.system.includes('lue par parties. Uniquement'));
    expect(parts.length).toBeGreaterThan(3);
    expect(seen).toEqual(parts.map((_, i) => i + 1));
    expect(s.parts).toBe(parts.length);
    // Every line read, once.
    expect(parts.flatMap((p) => idsIn(p.user))).toEqual(linesOf(t.cues).map((l) => l.id));
    // Then one request to merge them.
    expect(w.asked.at(-1)!.system).toContain('lue par parties : voici, pour chacune');
    expect(steps.at(-1)).toBe('merge');
  });

  it('trop longue pour ce palier gratuit après tout : relue par parties plus petites', async () => {
    const w = fakeWriter(100_000, { tooLargeOver: 6_000 });
    const s = await summarizeLesson({ noteId: 'n1', title: 'Delta', transcript: transcript(200) }, w);
    expect(s.parts).toBeGreaterThan(1);
  });
});

describe('résumé : le cours entier', () => {
  function seed(area: MemoryArea) {
    const index = {
      a: { course: 'Databricks', chapter: 'Delta Lake', title: 'ACID', url: 'https://www.youtube.com/watch?v=a', updatedAt: 3 },
      b: { course: 'Databricks', chapter: 'Lakehouse', title: 'Intro', url: 'https://www.youtube.com/watch?v=b', updatedAt: 1 },
      c: { course: 'databricks', chapter: 'Delta Lake', title: 'OPTIMIZE', url: 'https://www.youtube.com/watch?v=c', updatedAt: 4 },
      x: { course: 'Autre cours', chapter: 'Chapitre 1', title: 'Ailleurs', url: 'u', updatedAt: 1 },
    };
    const note = (id: string, createdAt: number) => ({ id, title: (index as Record<string, { title: string }>)[id].title, url: 'u', markdown: '', createdAt, updatedAt: createdAt, rev: 1, platform: 'youtube' });
    return area.set({
      'notes:index': index,
      'note:a': note('a', 30),
      'note:b': { ...note('b', 10), chapter: 'Lakehouse', course: 'Databricks' },
      'note:c': note('c', 40),
      'transcript:a': transcript(40, { noteId: 'a' }),
      'transcript:b': transcript(25, { noteId: 'b' }),
    });
  }

  it('ses chapitres et leçons dans l’ordre où ils ont été commencés ; chaque leçon lue en entier, puis la synthèse du cours d’après toutes les transcriptions', async () => {
    const area = new MemoryArea();
    vi.stubGlobal('chrome', { storage: { local: area } });
    await seed(area);
    const content = await courseContent('DATABRICKS');
    expect(content.chapters).toEqual(['Lakehouse', 'Delta Lake']);
    expect(content.lessons.map((l) => l.title)).toEqual(['Intro', 'ACID', 'OPTIMIZE']);
    const w = fakeWriter(500_000);
    const steps: string[] = [];
    const s = await summarizeCourse('Databricks', w, { onStep: (st) => steps.push(st.phase === 'lesson' ? `lesson ${st.k}/${st.n}` : st.phase) });
    // Two lessons with a transcript, read; the third has none.
    expect(steps.filter((x) => x.startsWith('lesson'))).toEqual(['lesson 1/2', 'lesson 2/2']);
    const course = w.asked.at(-1)!;
    expect(course.system).toContain('puis sa transcription complète');
    expect(course.user).toContain('## Chapitre 1 · Lakehouse');
    expect(course.user).toContain('Transcription :');
    expect(s.full).toBe(true);
    expect(s).toMatchObject({ course: 'Databricks', problem: 'Comment fiabiliser un data lake ?', goals: [{ text: 'Comprendre le journal', chapter: 1 }] });
    expect(s.chapters.map((c) => [c.title, c.lessons.map((l) => [l.title, l.state])])).toEqual([
      ['Lakehouse', [['Intro', 'done']]],
      ['Delta Lake', [['ACID', 'done'], ['OPTIMIZE', 'none']]],
    ]);
    expect(s.chapters[0].lessons[0].synthesis).toBe('La première leçon.');
    // Kept: the lessons' summaries and the course's.
    expect(area.data.has('summary:a')).toBe(true);
    expect(area.data.has('course-summary:databricks')).toBe(true);

    // Again, nothing changed: no lesson read again — only the course's synthesis.
    const again = fakeWriter(500_000);
    await summarizeCourse('Databricks', again);
    expect(again.asked).toHaveLength(1);
    // A transcript grows: that lesson is « à mettre à jour ».
    await area.set({ 'transcript:b': transcript(60, { noteId: 'b' }) });
    expect(staleLessons(s, await courseContent('Databricks')).map((l) => l.title)).toEqual(['Intro']);
  });

  it('trop long pour lire toutes les transcriptions d’un coup : la synthèse du cours d’après les résumés des leçons (chacune lue en entier)', async () => {
    const area = new MemoryArea();
    vi.stubGlobal('chrome', { storage: { local: area } });
    await seed(area);
    const w = fakeWriter(3_000);
    const s = await summarizeCourse('Databricks', w);
    expect(s.full).toBe(false);
    expect(w.asked.at(-1)!.user).not.toContain('Transcription :');
  });

  it('la synthèse du cours lue : chapitres numérotés, leçons L1…', () => {
    const d = parseCourse('{"problem":"P ?","goals":[{"text":"G","chapter":"ch. 2"},{"text":"H","chapter":"9"}],"solution":"S","chapters":[{"id":"2","synthesis":"Deux"}],"lessons":[{"id":"[L3]","synthesis":"Trois"}]}', 2);
    expect(d.goals).toEqual([{ text: 'G', chapter: 2 }, { text: 'H', chapter: null }]);
    expect(d.chapters.get(2)).toBe('Deux');
    expect(d.lessons.get('L3')).toBe('Trois');
  });
});
