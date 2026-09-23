import { describe, expect, it } from 'vitest';
import {
  countNotes,
  findAnchors,
  findFragmentLinks,
  findPins,
  findSectionRefs,
  findWikiLinks,
  linkedTitles,
  normalizeTitle,
  parseTextFragment,
  pinToken,
  quoteLine,
  sectionToken,
  textFragmentUrl,
  wikiLinkToken,
  appendBlock,
  captureLine,
  findAssetRefs,
  findPageRefs,
  findTimestamps,
  pageRefToken,
  timestampToken,
  toPortableMarkdown,
} from '../../src/shared/markdown';

describe('findTimestamps', () => {
  it('finds bare and linked timestamps with their positions', () => {
    const text = 'Intro [00:05] puis [1:02:03](https://x.test#t=3723).';
    const found = findTimestamps(text, 10);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ label: '00:05', seconds: 5, url: null, from: 16, labelTo: 23, to: 23 });
    expect(found[1]).toMatchObject({ label: '1:02:03', seconds: 3723, url: 'https://x.test#t=3723' });
    expect(text.slice(found[1].from - 10, found[1].to - 10)).toBe('[1:02:03](https://x.test#t=3723)');
  });

  it('ignores image alt texts and invalid values', () => {
    expect(findTimestamps('![04:15](assets/a.jpg) [04:75]')).toEqual([]);
  });
});

describe('capture lines and assets', () => {
  it('writes the timestamp then the thumbnail', () => {
    expect(timestampToken(255)).toBe('[04:15]');
    expect(captureLine(255, 'assets/yt-04-15.jpg')).toBe('[04:15] ![Capture 04:15](assets/yt-04-15.jpg)');
  });

  it('lists referenced screenshots once', () => {
    const md = '![a](assets/one.jpg)\n![b](assets/two.png) ![a again](assets/one.jpg) ![web](https://x/y.png)';
    expect(findAssetRefs(md)).toEqual(['assets/one.jpg', 'assets/two.png']);
  });

  it('appends blocks on their own line', () => {
    expect(appendBlock('', 'X')).toBe('X\n');
    expect(appendBlock('a', 'X')).toBe('a\nX\n');
    expect(appendBlock('a\n', 'X')).toBe('a\nX\n');
  });
});

describe('toPortableMarkdown', () => {
  const note = {
    title: 'Cours "React"',
    url: 'https://www.youtube.com/watch?v=abcdefghijk',
    platform: 'youtube',
    markdown: '[00:10] Hooks\n`[00:20]` code\n```\n[00:30] in fence\n```\n[00:40](https://keep.me) déjà un lien',
    createdAt: Date.UTC(2026, 0, 1),
    updatedAt: Date.UTC(2026, 0, 2),
  };

  it('links bare timestamps outside code and adds a front matter', () => {
    const out = toPortableMarkdown(note);
    expect(out).toContain('title: "Cours \\"React\\""');
    expect(out).toContain('source: https://www.youtube.com/watch?v=abcdefghijk');
    expect(out).toContain('[00:10](https://www.youtube.com/watch?v=abcdefghijk#t=10) Hooks');
    expect(out).toContain('`[00:20]` code');
    expect(out).toContain('\n[00:30] in fence\n');
    expect(out).toContain('[00:40](https://keep.me) déjà un lien');
  });

  it('can skip the front matter', () => {
    expect(toPortableMarkdown(note, { frontMatter: false }).startsWith('[00:10](')).toBe(true);
  });
});

describe('file names', async () => {
  const { asciiFileName, safeFileName } = await import('../../src/shared/encoding');
  it('keeps readable, portable names', () => {
    expect(safeFileName('Cours: React / Hooks?')).toBe('Cours React Hooks');
    expect(safeFileName('...')).toBe('note');
    expect(asciiFileName('Vidéo façon « Été »')).toBe('Video facon Ete');
  });
});

describe('page references', () => {
  it('finds [p. N] references but not images', () => {
    const text = 'Voir [p. 12] et [p.3], pas ![p. 4](x.png).';
    expect(findPageRefs(text, 100)).toEqual([
      { from: 105, to: 112, page: 12 },
      { from: 116, to: 121, page: 3 },
    ]);
  });

  it('formats page tokens', () => {
    expect(pageRefToken(7)).toBe('[p. 7]');
    expect(pageRefToken(0)).toBe('[p. 1]');
    expect(pageRefToken(3.8)).toBe('[p. 3]');
  });
});

describe('anchors of every kind', () => {
  it('finds paragraphs and pins', () => {
    expect(findSectionRefs('Voir [§ 12] puis [§3]')).toEqual([
      { from: 5, to: 11, kind: 'section', value: 12, labelFrom: 8 },
      { from: 17, to: 21, kind: 'section', value: 3, labelFrom: 19 },
    ]);
    expect(findPins('[pin 3] axe des x ; [PIN 12]').map((p) => p.value)).toEqual([3, 12]);
    expect(sectionToken(4)).toBe('[§ 4]');
    expect(pinToken(2.7)).toBe('[pin 2]');
  });

  it('lists every anchor in document order', () => {
    const text = '[pin 2] courbe\n[00:05] intro [p. 3] et [§ 4]';
    expect(findAnchors(text).map((a) => `${a.kind}:${a.value}`)).toEqual(['pin:2', 'time:5', 'page:3', 'section:4']);
  });
});

describe('wiki links', () => {
  it('finds [[Titre]] and [[Titre|texte]]', () => {
    const text = 'Voir [[Lois de Newton]] et [[Dérivées|la dérivée]].';
    const links = findWikiLinks(text);
    expect(links.map((l) => [l.title, l.label])).toEqual([
      ['Lois de Newton', 'Lois de Newton'],
      ['Dérivées', 'la dérivée'],
    ]);
    expect(text.slice(links[1].labelFrom, links[1].labelTo)).toBe('la dérivée');
    expect(text.slice(links[0].labelFrom, links[0].labelTo)).toBe('Lois de Newton');
    expect(findWikiLinks('[[ ]] [[a\nb]]')).toEqual([]);
  });

  it('dedupes linked titles and compares them loosely', () => {
    expect(linkedTitles('[[Énergie]] [[energie]] [[Force]]')).toEqual(['Énergie', 'Force']);
    expect(normalizeTitle('  Énergie   Cinétique ')).toBe('energie cinetique');
    expect(wikiLinkToken('A [b] | c')).toBe('[[A b c]]');
  });
});

describe('text fragments', () => {
  it('links to a passage, shortening long quotes', () => {
    expect(textFragmentUrl('https://x.test/cours#intro', 'La loi d’Ohm, U = R-I')).toBe(
      'https://x.test/cours#:~:text=La%20loi%20d%E2%80%99Ohm%2C%20U%20%3D%20R%2DI',
    );
    const long = 'un deux trois quatre cinq six sept huit neuf dix onze douze';
    expect(textFragmentUrl('https://x.test/a', long)).toBe(
      'https://x.test/a#:~:text=un%20deux%20trois%20quatre%20cinq,huit%20neuf%20dix%20onze%20douze',
    );
    expect(parseTextFragment(textFragmentUrl('https://x.test/a', long))).toEqual({
      start: 'un deux trois quatre cinq',
      end: 'huit neuf dix onze douze',
    });
    expect(parseTextFragment('https://x.test/a#top')).toBeNull();
  });

  it('keeps URLs with parentheses inside the Markdown link', () => {
    const url = textFragmentUrl('https://fr.wikipedia.org/wiki/Loi_(physique)', 'la loi (empirique)');
    expect(url).toBe('https://fr.wikipedia.org/wiki/Loi_%28physique%29#:~:text=la%20loi%20%28empirique%29');
    const line = quoteLine('la loi (empirique)', 'https://fr.wikipedia.org/wiki/Loi_(physique)');
    expect(findFragmentLinks(line)).toHaveLength(1);
    expect(parseTextFragment(url)).toEqual({ start: 'la loi (empirique)', end: null });
  });

  it('counts anchored lines and quoted passages as notes', () => {
    expect(countNotes('[00:01] a\n[p. 3] b\n> cité [↗](https://x.test/a#:~:text=cit%C3%A9)\n[[Fiche]] seule')).toBe(3);
  });

  it('writes and finds quote lines', () => {
    const line = quoteLine('  La  photosynthèse ', 'https://x.test/bio');
    expect(line).toBe('> La photosynthèse [↗](https://x.test/bio#:~:text=La%20photosynth%C3%A8se)');
    const [m] = findFragmentLinks(line, 10);
    expect(m).toMatchObject({ label: '↗', url: 'https://x.test/bio#:~:text=La%20photosynth%C3%A8se' });
    expect(m.from).toBe(10 + line.indexOf('[↗]'));
  });
});

