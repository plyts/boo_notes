// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isCaptionType, isCaptionUrl, readCaptionPayload } from '../../src/shared/caption-bridge';
import { captionFile, parseYouTubeTranscript, readLiveLines, SubtitleCollector } from '../../src/content/subtitles';
import type { CaptionState } from '../../src/shared/messages';
import { looksLikeSubtitles, normalizeLang, parseTimedXml, readCaptionFile, type Cue } from '../../src/shared/transcript';
import type { TranscriptInfo } from '../../src/shared/transcript-store';

const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello there\n\n00:00:03.000 --> 00:00:05.000\nGeneral Kenobi\n';

describe('subtitle files downloaded by players', () => {
  it('recognises their URLs and content types (not thumbnails nor chapters)', () => {
    expect(isCaptionUrl('https://www.youtube.com/api/timedtext?v=abc&lang=en&pot=XYZ')).toBe(true);
    expect(isCaptionUrl('https://cdn.example.com/hls/subs/en/seg-12.vtt')).toBe(true);
    expect(isCaptionUrl('https://fast.wistia.com/embed/captions/abc123.json')).toBe(true);
    expect(isCaptionUrl('https://player.vimeo.com/texttrack/12345.vtt?token=a')).toBe(true);
    expect(isCaptionUrl('https://cdn.example.com/video/thumbnails.vtt')).toBe(false);
    expect(isCaptionUrl('https://cdn.example.com/video/chapters.vtt')).toBe(false);
    expect(isCaptionUrl('https://cdn.example.com/video/seg-1.m4s')).toBe(false);
    expect(isCaptionType('text/vtt; charset=utf-8')).toBe(true);
    expect(isCaptionType('application/ttml+xml')).toBe(true);
    expect(isCaptionType('video/mp4')).toBe(false);
  });

  it('checks what crosses from the page world', () => {
    expect(readCaptionPayload(JSON.stringify({ url: 'a.vtt', body: VTT, contentType: 'text/vtt', at: 5 }))).toEqual({ url: 'a.vtt', body: VTT, contentType: 'text/vtt', at: 5 });
    expect(readCaptionPayload({ url: 'a.vtt' })).toBeNull();
    expect(readCaptionPayload('not json')).toBeNull();
    expect(readCaptionPayload(JSON.stringify({ url: 1, body: '' }))).toBeNull();
  });

  it('reads WebVTT, SubRip, TTML, YouTube srv3 and json3', () => {
    expect(readCaptionFile(VTT).cues.map((c) => c.text)).toEqual(['Hello there', 'General Kenobi']);
    expect(readCaptionFile('1\n00:00:01,000 --> 00:00:02,500\nBonjour\n').cues[0]).toMatchObject({ start: 1, end: 2.5, text: 'Bonjour' });
    const ttml = '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="00:00:01.500" end="00:00:03.000">Line <br/>one</p><p begin="4s" dur="1.5s">two</p></div></body></tt>';
    expect(parseTimedXml(ttml)).toMatchObject([
      { start: 1.5, end: 3, text: 'Line one' },
      { start: 4, end: 5.5, text: 'two' },
    ]);
    const srv3 = '<?xml version="1.0"?><timedtext format="3"><body><p t="1200" d="1800" w="1"><s>hello</s><s t="400"> world</s></p><p t="3000" d="900">it&#39;s me</p></body></timedtext>';
    expect(readCaptionFile(srv3).cues).toMatchObject([
      { start: 1.2, end: 3, text: 'hello world' },
      { start: 3, end: 3.9, text: 'it’s me'.replace('’', "'") },
    ]);
    const json3 = JSON.stringify({ events: [{ tStartMs: 500, dDurationMs: 1000, segs: [{ utf8: 'hi' }] }] });
    expect(readCaptionFile(json3).cues).toMatchObject([{ start: 0.5, end: 1.5, text: 'hi' }]);
  });

  it('finds subtitles inside JSON (Wistia-like, or a list of cues) with their language', () => {
    const wistia = JSON.stringify({ captions: [{ language: 'eng', text: VTT }, { language: 'fra', text: VTT.replace('Hello there', 'Bonjour') }] });
    const read = readCaptionFile(wistia);
    expect(read.lang).toBe('en');
    expect(read.cues[0].text).toBe('Hello there');
    const list = JSON.stringify({ lang: 'fr', items: [{ startMs: 1000, endMs: 2000, text: 'un' }, { startMs: 2000, endMs: 3000, text: 'deux' }] });
    expect(readCaptionFile(list)).toMatchObject({ lang: 'fr', cues: [{ start: 1, end: 2, text: 'un' }, { start: 2, end: 3, text: 'deux' }] });
    expect(readCaptionFile(JSON.stringify({ title: 'not captions' })).cues).toEqual([]);
    expect(normalizeLang('pt_BR')).toBe('pt-BR');
    expect(normalizeLang('ger')).toBe('de');
    expect(normalizeLang('hello world')).toBe('');
  });

  it('leaves out thumbnail maps', () => {
    const thumbs = 'WEBVTT\n\n00:00.000 --> 00:05.000\nsprite.jpg#xywh=0,0,160,90\n\n00:05.000 --> 00:10.000\nsprite.jpg#xywh=160,0,160,90\n';
    expect(looksLikeSubtitles(readCaptionFile(thumbs).cues)).toBe(false);
    expect(captionFile({ url: 'https://cdn.example.com/p/storyboard.vtt', contentType: 'text/vtt', body: thumbs, at: 0 })).toBeNull();
  });

  it('names YouTube captions, and the language of a player’s file', () => {
    const yt = captionFile({ url: 'https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&kind=asr&pot=1', contentType: 'application/json', body: JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 900, segs: [{ utf8: 'hi' }] }] }), at: 0 });
    expect(yt).toMatchObject({ source: 'platform', lang: 'en', complete: true, label: 'Sous-titres YouTube · anglais (automatiques)' });
    const hls = captionFile({ url: 'https://cdn.example.com/hls/subs_fr/seg-3.vtt', contentType: 'text/vtt', body: VTT, at: 0 }, 'https://example.com/');
    expect(hls).toMatchObject({ source: 'track', lang: 'fr', complete: false, label: 'Sous-titres du lecteur · français' });
  });
});

describe('YouTube transcript panel (get_transcript)', () => {
  it('reads the segments and the language selected', () => {
    const response = {
      actions: [
        {
          updateEngagementPanelAction: {
            content: {
              transcriptRenderer: {
                content: {
                  transcriptSearchPanelRenderer: {
                    body: {
                      transcriptSegmentListRenderer: {
                        initialSegments: [
                          { transcriptSegmentRenderer: { startMs: '0', endMs: '2400', snippet: { runs: [{ text: 'Welcome to ' }, { text: 'Airflow' }] } } },
                          { transcriptSectionHeaderRenderer: { snippet: { simpleText: 'Intro' } } },
                          { transcriptSegmentRenderer: { startMs: '2400', endMs: '5000', snippet: { simpleText: 'DAGs are graphs' } } },
                        ],
                      },
                    },
                    footer: {
                      transcriptFooterRenderer: {
                        languageMenu: {
                          sortFilterSubMenuRenderer: {
                            subMenuItems: [
                              { title: 'Anglais (générés automatiquement)', selected: true },
                              { title: 'Français', selected: false },
                            ],
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      ],
    };
    const { cues, language } = parseYouTubeTranscript(response);
    expect(language).toBe('Anglais (générés automatiquement)');
    expect(cues).toMatchObject([
      { start: 0, end: 2.4, text: 'Welcome to Airflow' },
      { start: 2.4, end: 5, text: 'DAGs are graphs' },
    ]);
  });
});

describe('subtitles on screen of unknown players', () => {
  it('reads caption-looking elements drawn over the video, not the player controls', () => {
    document.body.innerHTML = `
      <div class="my-player">
        <video width="640" height="360"></video>
        <div class="vp-captions"><span>Line one</span></div>
        <button class="captions-toggle">Subtitles</button>
        <div class="captions-menu"><span>English</span></div>
      </div>`;
    const video = document.querySelector('video')!;
    const rect = (x: number, y: number, w: number, hgt: number) => ({ left: x, top: y, right: x + w, bottom: y + hgt, width: w, height: hgt, x, y, toJSON: () => ({}) }) as DOMRect;
    video.getBoundingClientRect = () => rect(0, 0, 640, 360);
    for (const el of document.querySelectorAll<HTMLElement>('.vp-captions, .captions-menu, .captions-toggle')) el.getBoundingClientRect = () => rect(100, 300, 400, 30);
    Element.prototype.getClientRects = function () {
      return [{}] as unknown as DOMRectList;
    };
    expect(readLiveLines(document, video)).toEqual(['Line one']);
    expect(readLiveLines(document, null)).toBeNull();
  });
});

describe('SubtitleCollector', () => {
  const setup = () => {
    const flushed: Array<{ info: TranscriptInfo; cues: Cue[]; replace: boolean }> = [];
    const states: CaptionState[] = [];
    let stored = true;
    const collector = new SubtitleCollector({
      flush: async (_id, info, cues, replace) => {
        flushed.push({ info, cues, replace });
        return stored;
      },
      caption: (_cue, state) => states.push(state),
    });
    return { collector, flushed, states, refuse: (v: boolean) => (stored = !v) };
  };

  it('takes a file downloaded by the player as the whole transcript', async () => {
    const { collector, flushed, states } = setup();
    collector.reset('web:lesson', 'web');
    const found = captionFile({ url: 'https://cdn.example.com/lesson.en.vtt', contentType: 'text/vtt', body: VTT.repeat(1), at: 0 })!;
    collector.offerFile({ ...found, complete: true });
    collector.tick(null, 1.5, true, 10, true);
    await Promise.resolve();
    expect(flushed.at(-1)).toMatchObject({ replace: true, info: { source: 'track', lang: 'en', complete: true } });
    expect(flushed.at(-1)!.cues.map((c) => c.text)).toEqual(['Hello there', 'General Kenobi']);
    expect(states.at(-1)).toMatchObject({ status: 'complete', source: 'track' });
  });

  it('merges the pieces of a stream’s subtitles', () => {
    const { collector } = setup();
    collector.reset('web:live', 'web');
    const piece = (start: number, text: string) =>
      captionFile({ url: `https://cdn.example.com/subs/en/seg-${start}.vtt`, contentType: 'text/vtt', body: `WEBVTT\n\n00:00:${String(start).padStart(2, '0')}.000 --> 00:00:${String(start + 2).padStart(2, '0')}.000\n${text}\n`, at: 0 })!;
    collector.offerFile(piece(1, 'one'));
    collector.offerFile(piece(10, 'two'));
    expect(collector.count).toBe(2);
  });

  it('stops sending again and again while nothing is kept (no note, panel closed)', async () => {
    const { collector, flushed, refuse } = setup();
    refuse(true);
    collector.reset('web:lesson', 'web');
    collector.offerFile(captionFile({ url: 'https://cdn.example.com/lesson.en.vtt', contentType: 'text/vtt', body: VTT, at: 0 })!);
    collector.tick(null, 1, true, 10, false);
    await new Promise((r) => setTimeout(r, 10));
    collector.tick(null, 1.3, true, 10, false);
    collector.tick(null, 1.6, true, 10, false);
    expect(flushed).toHaveLength(1);
    // The panel opens: sent again at once.
    refuse(false);
    await new Promise((r) => setTimeout(r, 600));
    collector.tick(null, 2, true, 10, true);
    expect(flushed).toHaveLength(2);
  });

  it('keeps YouTube’s original captions when its machine translation is downloaded too', async () => {
    const { collector, flushed } = setup();
    collector.reset('youtube:abcdefghijk', 'youtube');
    const json = (text: string) => JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 900, segs: [{ utf8: text }] }] });
    const yt = (q: string, text: string) => captionFile({ url: `https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en${q}`, contentType: 'application/json', body: json(text), at: 0 })!;
    collector.offerFile(yt('', 'hello'));
    const translated = yt('&tlang=fr', 'bonjour');
    expect(translated.translated).toBe(true);
    collector.offerFile(translated);
    collector.tick(null, 0.5, true, 10, true);
    await Promise.resolve();
    expect(flushed.at(-1)!.cues.map((c) => c.text)).toEqual(['hello']);
    expect(flushed.at(-1)!.info).toMatchObject({ lang: 'en', label: 'Sous-titres YouTube · anglais' });
  });

  it('says when the platform has no subtitles for the media (reported by the page)', () => {
    const { collector, states } = setup();
    collector.reset('web:x', 'web');
    collector.tick(null, 0, false, 10, true);
    expect(states.at(-1)?.status).toBe('searching');
  });
});
