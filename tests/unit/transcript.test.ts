import { describe, expect, it } from 'vitest';
import { findTimestamps, toPortableMarkdown } from '../../src/shared/markdown';
import { plainText } from '../../src/shared/cards';
import { markdownToBlocks, transcriptBlocks } from '../../src/shared/notion/blocks';
import {
  addCoverage,
  applyLiveSample,
  cleanCueText,
  coverageRatio,
  cueIndexAt,
  cueQuote,
  cuesInRange,
  emptyTranscript,
  findMediaRefs,
  findPassages,
  findTranscriptLine,
  languagesLabel,
  mergeCues,
  notesInRange,
  parseVtt,
  parseYouTubeJson3,
  passageImagePath,
  passageLine,
  passageMediaPath,
  setPassageMedia,
  transcriptLine,
  transcriptToMarkdown,
  transcriptToVtt,
  type Cue,
} from '../../src/shared/transcript';

const VTT = `WEBVTT
Kind: captions
Language: en

STYLE
::cue { color: yellow }

NOTE a comment

1
00:00:01.000 --> 00:00:03.500 align:start position:0%
<v Prof>So let&#39;s look at the <c.yellow>theorem</c>.</v>

00:00:03.500 --> 00:00:06.000
The circulation of F
around the boundary

00:00:06.000 --> 00:00:07.000
around the boundary

01:02:03.250 --> 01:02:05.000
&amp; that&rsquo;s it
`;

const SRT = `1
00:00:01,000 --> 00:00:03,500
Bonjour à tous

2
00:00:04,000 --> 00:00:06,000
<i>Aujourd'hui</i> : Stokes
`;

describe('parseVtt', () => {
  it('reads WebVTT cues, skipping styles and notes, cleaning markup and entities', () => {
    const cues = parseVtt(VTT);
    expect(cues.map((c) => c.text)).toEqual([
      "So let's look at the theorem.",
      'The circulation of F around the boundary',
      'around the boundary',
      '& that’s it',
    ]);
    expect(cues[0]).toMatchObject({ id: 'c100', start: 1, end: 3.5 });
    expect(cues[3].start).toBeCloseTo(3723.25);
  });

  it('reads SubRip (.srt) too', () => {
    const cues = parseVtt(SRT);
    expect(cues).toHaveLength(2);
    expect(cues[1]).toMatchObject({ start: 4, end: 6, text: "Aujourd'hui : Stokes" });
  });

  it('merges a line repeated by rolling captions into one cue', () => {
    const cues = parseVtt('WEBVTT\n\n00:01.000 --> 00:02.000\nHello\n\n00:02.000 --> 00:04.000\nHello\n');
    expect(cues).toEqual([{ id: 'c100', start: 1, end: 4, text: 'Hello' }]);
  });
});

describe('parseYouTubeJson3', () => {
  it('reads timed events and ignores window / empty events', () => {
    const cues = parseYouTubeJson3({
      events: [
        { tStartMs: 0, dDurationMs: 90000, id: 1, wpWinPosId: 1 },
        { tStartMs: 1200, dDurationMs: 2300, segs: [{ utf8: 'the curl ' }, { utf8: 'of F' }] },
        { tStartMs: 3500, segs: [{ utf8: '\n' }] },
        { tStartMs: 3600, dDurationMs: 1000, segs: [{ utf8: '[Music]' }] },
      ],
    });
    expect(cues).toEqual([
      { id: 'c120', start: 1.2, end: 3.5, text: 'the curl of F' },
      { id: 'c360', start: 3.6, end: 4.6, text: '[Music]' },
    ]);
    expect(parseYouTubeJson3(null)).toEqual([]);
  });
});

describe('cues', () => {
  it('cleans subtitle text', () => {
    expect(cleanCueText('  <00:00:01.000><c>a</c>  b&nbsp;&#x41; {\\an8}c ')).toBe('a b A c');
  });

  it('keeps translations and comments when a track is merged again', () => {
    const base: Cue[] = [{ id: 'c100', start: 1, end: 2, text: 'hello', tr: 'bonjour', note: 'important' }];
    const merged = mergeCues(base, [
      { id: 'c100', start: 1, end: 2.5, text: 'hello there' },
      { id: 'c300', start: 3, end: 4, text: 'next' },
    ]);
    expect(merged).toEqual([
      { id: 'c100', start: 1, end: 2.5, text: 'hello there', tr: 'bonjour', note: 'important' },
      { id: 'c300', start: 3, end: 4, text: 'next' },
    ]);
  });

  it('finds the cue being spoken, and the cues of a range', () => {
    const cues = parseVtt(VTT);
    expect(cueIndexAt(cues, 0.5)).toBe(-1);
    expect(cueIndexAt(cues, 2)).toBe(0);
    expect(cueIndexAt(cues, 6.5)).toBe(2);
    expect(cueIndexAt(cues, 30)).toBe(-1);
    expect(cuesInRange(cues, 3, 6).map((c) => c.id)).toEqual(['c100', 'c350']);
  });
});

describe('applyLiveSample (captions captured as displayed)', () => {
  it('grows rolling captions and starts a cue per new line', () => {
    const cues: Cue[] = [];
    expect(applyLiveSample(cues, 10, ['the curl'])).toBe(true);
    expect(applyLiveSample(cues, 10.8, ['the curl of F'])).toBe(true);
    expect(applyLiveSample(cues, 11.6, ['the curl of F', 'through S'])).toBe(true);
    expect(applyLiveSample(cues, 12.4, ['through S'])).toBe(true);
    expect(applyLiveSample(cues, 12.4, ['through S'])).toBe(false);
    expect(cues.map((c) => [c.text, c.start, c.end])).toEqual([
      ['the curl of F', 10, 11.6],
      ['through S', 11.61, 12.4],
    ]);
    expect(new Set(cues.map((c) => c.id)).size).toBe(2);
  });

  it('treats the same sentence minutes later as a new line', () => {
    const cues: Cue[] = [];
    applyLiveSample(cues, 5, ['Any questions?']);
    applyLiveSample(cues, 300, ['Any questions?']);
    expect(cues.map((c) => c.start)).toEqual([5, 300]);
  });
});

describe('coverage', () => {
  it('merges ranges and bridges small gaps', () => {
    let r: Array<[number, number]> = [];
    r = addCoverage(r, 0, 10);
    r = addCoverage(r, 11, 20);
    r = addCoverage(r, 40, 50);
    r = addCoverage(r, 30, 30);
    expect(r).toEqual([
      [0, 20],
      [40, 50],
    ]);
    expect(coverageRatio({ complete: false, covered: r, duration: 100 })).toBeCloseTo(0.3);
    expect(coverageRatio({ complete: true, covered: [], duration: 0 })).toBe(1);
  });
});

describe('transcript documents', () => {
  const t = emptyTranscript('youtube:abc', {
    lang: 'en',
    label: 'Sous-titres YouTube',
    source: 'platform',
    cues: [
      { id: 'c125', start: 125, end: 128, text: 'The circulation of F', tr: 'La circulation de F', note: 'orientation !' },
      { id: 'c130', start: 130, end: 131, text: 'equals the flux' },
    ],
  });

  it('labels languages and writes the pinned line', () => {
    expect(languagesLabel(t)).toBe('anglais → français');
    expect(languagesLabel({ ...t, cues: [] })).toBe('anglais');
    const line = transcriptLine(t);
    expect(line).toBe('📄 [Transcription — anglais → français · 2 répliques](transcripts/youtube-abc.md)');
    expect(findTranscriptLine(`# Note\n\n${line}\n`)).toEqual({ from: 8, to: 8 + line.length, path: 'transcripts/youtube-abc.md' });
    expect(findTranscriptLine('rien')).toBeNull();
  });

  it('quotes a cue and exports Markdown and WebVTT', () => {
    expect(cueQuote(t.cues[0])).toBe('> [02:05] « The circulation of F » — *La circulation de F*');
    expect(cueQuote(t.cues[1])).toBe('> [02:10] « equals the flux »');
    const md = transcriptToMarkdown(t, { title: 'Stokes', url: 'https://youtu.be/abc' });
    expect(md).toContain('# Transcription — Stokes');
    expect(md).toContain('[02:05] The circulation of F\n*La circulation de F*\n💬 orientation !');
    expect(transcriptToVtt(t, true)).toBe(
      'WEBVTT\n\n00:02:05.000 --> 00:02:08.000\nLa circulation de F\n\n00:02:10.000 --> 00:02:11.000\nequals the flux\n',
    );
    expect(parseVtt(transcriptToVtt(t)).map((c) => c.text)).toEqual(['The circulation of F', 'equals the flux']);
  });
});

describe('passages', () => {
  const image = passageImagePath('youtube:abc', 125, 'k3j');
  const media = passageMediaPath('youtube:abc', 125, 'k3j');
  const line = passageLine({ start: 125, end: 367, title: 'Théorème [de] Stokes', image });

  it('writes and finds passage lines', () => {
    expect(image).toBe('assets/youtube-abc-passage-02-05-k3j.jpg');
    expect(media).toBe('media/youtube-abc-passage-02-05-k3j.webm');
    expect(line).toBe(`[02:05–06:07] ![Passage 02:05–06:07 · Théorème de Stokes](${image})`);
    const md = `[02:00] Intro\n${line}\n[03:00] Pendant\n[07:00] Après`;
    expect(findPassages(md)).toEqual([
      { from: 14, to: 14 + line.length, start: 125, end: 367, title: 'Théorème de Stokes', image, media: null },
    ]);
    const withMedia = setPassageMedia(md, 125, media);
    expect(findPassages(withMedia)[0].media).toBe(media);
    expect(findMediaRefs(withMedia)).toEqual([media]);
    expect(notesInRange(withMedia, 125, 367)).toEqual(['[03:00] Pendant']);
  });

  it('accepts a hyphen and an untitled passage', () => {
    expect(findPassages('[02:05-06:07] ![Passage 02:05-06:07](assets/x.jpg)')[0]).toMatchObject({ start: 125, end: 367, title: '' });
  });
});

describe('range timestamps', () => {
  it('are found with their end, and invalid ranges are skipped', () => {
    const found = findTimestamps('[02:05–06:07] Stokes, [1:00:00 - 1:00:30](res:r1) et [06:07–02:05]');
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ label: '02:05', seconds: 125, end: 367, from: 0, labelTo: 13, url: null });
    expect(found[1]).toMatchObject({ seconds: 3600, end: 3630, resource: 'r1' });
    expect(findTimestamps('[04:15]')[0].end).toBeNull();
  });

  it('link to their start in portable Markdown, and read as text in cards', () => {
    const out = toPortableMarkdown(
      { title: 'x', url: 'https://www.youtube.com/watch?v=abcdefghijk', platform: 'youtube', markdown: '[02:05–06:07] Stokes', createdAt: 0, updatedAt: 0 },
      { frontMatter: false },
    );
    expect(out).toBe('[02:05–06:07](https://www.youtube.com/watch?v=abcdefghijk#t=125) Stokes');
    expect(plainText('[02:05–06:07] Stokes')).toBe('02:05–06:07 Stokes');
  });

  it('become a captioned image in Notion', () => {
    const blocks = markdownToBlocks('[02:05–06:07] ![Passage 02:05–06:07 · Stokes](assets/p.jpg) [Extrait](media/p.webm)');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'image', asset: 'assets/p.jpg' });
    const caption = (blocks[0] as { caption: Array<{ text: { content: string } }> }).caption.map((r) => r.text.content).join('');
    expect(caption).toBe('Passage 02:05–06:07 · Stokes');
  });
});

describe('transcript in Notion', () => {
  it('ends the page with one paragraph per line: time link, text, translation, comment', () => {
    const t = emptyTranscript('youtube:abc', {
      lang: 'en',
      label: 'Sous-titres YouTube',
      cues: [
        { id: 'c125', start: 125, end: 128, text: 'The circulation of F', tr: 'La circulation de F', note: 'orientation !' },
        { id: 'c130', start: 130, end: 131, text: 'equals the flux' },
      ],
    });
    const blocks = transcriptBlocks(t, (s) => `https://youtu.be/abc?t=${s}`) as Array<{ type: string; rich: Array<{ text: { content: string; link?: { url: string } }; annotations?: Record<string, boolean> }> }>;
    expect(blocks.map((b) => b.type)).toEqual(['heading_2', 'paragraph', 'paragraph', 'paragraph']);
    expect(blocks[1].rich[0].text.content).toBe('Sous-titres YouTube · anglais → français · 2 répliques');
    const first = blocks[2].rich;
    expect(first[0]).toMatchObject({ text: { content: '02:05', link: { url: 'https://youtu.be/abc?t=125' } }, annotations: { code: true } });
    expect(first.map((r) => r.text.content).join('')).toBe('02:05 The circulation of F\nLa circulation de F\n💬 orientation !');
    expect(transcriptBlocks({ ...t, cues: [] })).toEqual([]);
  });
});

