// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { extractJsonArray, pickYouTubeTrack, readLiveLines } from '../../src/content/subtitles';
import { NoteStore } from '../../src/shared/store';
import { carryAnnotations, pinTranscriptLine, type Cue } from '../../src/shared/transcript';
import { TranscriptStore, type TranscriptInfo } from '../../src/shared/transcript-store';
import { MemoryArea } from './helpers';

const live: TranscriptInfo = { lang: '', label: 'Sous-titres affichés', source: 'live', complete: false, duration: 600 };
const track: TranscriptInfo = { lang: 'en', label: 'Sous-titres du lecteur', source: 'track', complete: true, duration: 600 };
const cue = (id: string, start: number, text: string, extra: Partial<Cue> = {}): Cue => ({ id, start, end: start + 2, text, ...extra });

describe('TranscriptStore', () => {
  it('adds live cues as they come, with the watched stretches', async () => {
    const store = new TranscriptStore(new MemoryArea());
    await store.put('n', { ...live, covered: [0, 10] }, [cue('c100', 1, 'hello')], false);
    const t = await store.put('n', { ...live, covered: [11, 20] }, [cue('c100', 1, 'hello there'), cue('c500', 5, 'next')], false);
    expect(t.cues.map((c) => c.text)).toEqual(['hello there', 'next']);
    expect(t.covered).toEqual([[0, 20]]);
    expect(t.rev).toBe(2);
    expect(await store.getOutbox()).toEqual({ n: 2 });
  });

  it('keeps translations and comments, and lets a subtitles file replace a live capture', async () => {
    const store = new TranscriptStore(new MemoryArea());
    await store.put('n', live, [cue('c100', 1, 'hello'), cue('c510', 5.1, 'the curl')], false);
    await store.annotate('n', [{ id: 'c510', tr: 'le rotationnel', note: 'important' }, { id: 'c100', tr: '  ' }], { lang: 'en' });
    const t = await store.put('n', track, [cue('c100', 1, 'Hello.'), cue('c500', 5, 'The curl of F.'), cue('c900', 9, 'Next.')], true);
    expect(t).toMatchObject({ source: 'track', complete: true, lang: 'en' });
    expect(t.cues).toEqual([cue('c100', 1, 'Hello.'), cue('c500', 5, 'The curl of F.', { tr: 'le rotationnel', note: 'important' }), cue('c900', 9, 'Next.')]);
    // A live capture never overwrites the file afterwards.
    const after = await store.put('n', live, [cue('c1200', 12, 'noise')], false);
    expect(after.cues).toHaveLength(3);
  });

  it('clears a translation with an empty value', async () => {
    const store = new TranscriptStore(new MemoryArea());
    await store.put('n', track, [cue('c100', 1, 'a', { tr: 'x' })], true);
    const t = await store.annotate('n', [{ id: 'c100', tr: null }]);
    expect(t?.cues[0]).toEqual(cue('c100', 1, 'a'));
    expect(await store.annotate('missing', [])).toBeNull();
  });

  it('is removed with the notes', async () => {
    const area = new MemoryArea();
    await new TranscriptStore(area).put('n', track, [cue('c100', 1, 'a')], true);
    await new NoteStore(area).clearAll();
    expect(area.data.size).toBe(0);
  });
});

describe('transcript helpers', () => {
  it('carries annotations to the cue spoken at the same moment', () => {
    const out = carryAnnotations([cue('a', 4.9, 'x', { tr: 'X', note: 'n1' })], [cue('b', 0, 'y'), cue('c', 5, 'z', { note: 'n0' })]);
    expect(out[1]).toMatchObject({ tr: 'X', note: 'n0\nn1' });
    expect(out[0].tr).toBeUndefined();
  });

  it('pins the transcript line once, at the end, and updates it', () => {
    const line = '📄 [Transcription — anglais · 2 répliques](transcripts/x.md)';
    const once = pinTranscriptLine('Notes\n\n', line);
    expect(once).toBe(`Notes\n\n${line}\n`);
    expect(pinTranscriptLine(once, line.replace('2 répliques', '3 répliques'))).toBe(`Notes\n\n${line.replace('2 répliques', '3 répliques')}\n`);
    expect(pinTranscriptLine('', line)).toBe(`${line}\n`);
  });
});

describe('YouTube captions', () => {
  it('finds the caption list in the watch page', () => {
    const html = `<script>var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"/api/timedtext?a=1\\u0026b=[2]","name":{"simpleText":"Anglais \\"auto\\""},"languageCode":"en","kind":"asr"},{"baseUrl":"/api/timedtext?c=3","languageCode":"fr"}],"audioTracks":[]}}};</script>`;
    const tracks = extractJsonArray(html, '"captionTracks":') as Array<{ baseUrl: string; languageCode: string }>;
    expect(tracks).toHaveLength(2);
    expect(tracks[0].baseUrl).toBe('/api/timedtext?a=1&b=[2]');
    expect(extractJsonArray('nothing here', '"captionTracks":')).toBeNull();
  });

  it('prefers the spoken language: its manual subtitles, else the automatic ones', () => {
    const asr = { baseUrl: 'a', languageCode: 'en', kind: 'asr' };
    const enManual = { baseUrl: 'b', languageCode: 'en' };
    const frManual = { baseUrl: 'c', languageCode: 'fr' };
    expect(pickYouTubeTrack([frManual, asr, enManual])).toBe(enManual);
    expect(pickYouTubeTrack([frManual, asr])).toBe(asr);
    expect(pickYouTubeTrack([frManual])).toBe(frManual);
    expect(pickYouTubeTrack([])).toBeNull();
  });
});

describe('live subtitles on screen', () => {
  it('reads the lines drawn by the player, null when none are displayed', () => {
    document.body.innerHTML = '<div class="plyr__captions"><span class="plyr__caption">Bonjour</span></div>';
    // jsdom has no layout: every element counts as visible.
    Element.prototype.getClientRects = function () {
      return [{}] as unknown as DOMRectList;
    };
    expect(readLiveLines()).toEqual(['Bonjour']);
    document.body.innerHTML = '<div class="ytp-caption-window-container"></div>';
    expect(readLiveLines()).toBeNull();
  });
});
