import { rangeLabel } from '../shared/transcript';
import type { Shot } from './capture';

/**
 * Recording of what the media plays, through `captureStream()` and
 * MediaRecorder: the picture and sound of a passage, or only the sound (an
 * audio media, the audio trace of a course). Protected players (DRM) and
 * cross-origin media without CORS cannot be recorded.
 */
type CapturableMedia = HTMLMediaElement & { captureStream?: () => MediaStream };

/** Why `media` cannot be recorded, or null when it can. */
export function recordBlocker(media: HTMLMediaElement | null): string | null {
  if (!media) return 'aucun lecteur accessible (lecteur intégré ou chronomètre)';
  if (typeof (media as CapturableMedia).captureStream !== 'function' || typeof MediaRecorder === 'undefined') {
    return 'enregistrement non pris en charge par ce navigateur';
  }
  if (media.mediaKeys) return 'contenu protégé (DRM)';
  return null;
}

function pickMime(candidates: string[]): string {
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

export class Recording {
  private readonly recorder: MediaRecorder;
  private readonly chunks: Blob[] = [];
  private readonly done: Promise<Blob>;
  readonly mime: string;

  /** `video`: picture and sound (when there is sound); `audio`: sound only. Throws when nothing can be recorded. */
  constructor(media: HTMLMediaElement, what: 'video' | 'audio') {
    const blocker = recordBlocker(media);
    if (blocker) throw new Error(blocker);
    let stream: MediaStream;
    try {
      stream = (media as CapturableMedia).captureStream!();
    } catch {
      throw new Error('ce média ne se laisse pas enregistrer (source d’un autre site)');
    }
    const audio = stream.getAudioTracks();
    const video = what === 'video' ? stream.getVideoTracks() : [];
    if (!audio.length && !video.length) throw new Error(what === 'audio' ? 'pas de son à enregistrer' : 'rien à enregistrer');
    const tracks = new MediaStream([...video, ...audio]);
    const mime = video.length
      ? pickMime(audio.length ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'] : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'])
      : pickMime(['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']);
    this.recorder = new MediaRecorder(tracks, {
      ...(mime ? { mimeType: mime } : {}),
      // Speech: 48 kb/s Opus ≈ 20 MB per hour of sound; richer with a picture.
      audioBitsPerSecond: video.length ? 96_000 : 48_000,
      ...(video.length ? { videoBitsPerSecond: 900_000 } : {}),
    });
    this.mime = (this.recorder.mimeType || mime || (video.length ? 'video/webm' : 'audio/webm')).split(';')[0];
    this.done = new Promise<Blob>((resolve, reject) => {
      this.recorder.addEventListener('dataavailable', (e) => {
        if (e.data.size) this.chunks.push(e.data);
      });
      this.recorder.addEventListener('stop', () => resolve(new Blob(this.chunks, { type: this.mime })));
      this.recorder.addEventListener('error', (e) => reject((e as ErrorEvent).error ?? new Error('enregistrement interrompu')));
    });
    this.recorder.start(1000);
  }

  get active(): boolean {
    return this.recorder.state !== 'inactive';
  }

  pause(): void {
    if (this.recorder.state === 'recording') this.recorder.pause();
  }

  resume(): void {
    if (this.recorder.state === 'paused') this.recorder.resume();
  }

  stop(): Promise<Blob> {
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    return this.done;
  }
}

/**
 * Picture of a passage without a frame to show (audio media, passage chosen
 * afterwards): its range on a tinted card, with a waveform motif.
 */
export function passageCard(start: number, end: number, what: 'video' | 'audio', title: string): Promise<Shot> {
  const width = 640;
  const height = 360;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('Canvas indisponible'));
  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, '#2b2466');
  bg.addColorStop(1, '#6d5ef0');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);
  // Waveform motif, stable for a given range.
  let seed = Math.floor(start * 7 + end * 13) || 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
  for (let x = 24; x < width - 24; x += 10) {
    const h = 16 + rand() * 120 * Math.sin((x / width) * Math.PI);
    ctx.beginPath();
    ctx.roundRect(x, height / 2 - h / 2 + 30, 5, h, 3);
    ctx.fill();
  }
  const font = '-apple-system, BlinkMacSystemFont, "SF Pro Display", Inter, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = '#fff';
  ctx.font = `600 22px ${font}`;
  ctx.fillText(what === 'audio' ? '🔊 Passage audio' : '▶ Passage', 32, 52);
  ctx.font = `700 54px ${font}`;
  ctx.fillText(rangeLabel(start, end).replace('–', ' – '), 32, 118);
  if (title) {
    ctx.font = `500 22px ${font}`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.86)';
    const t = title.length > 48 ? `${title.slice(0, 47)}…` : title;
    ctx.fillText(t, 32, height - 32);
  }
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Encodage impossible'))), 'image/jpeg', 0.9),
  ).then(
    (blob) =>
      new Promise<Shot>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ dataUrl: String(reader.result), width, height, mime: 'image/jpeg' });
        reader.onerror = () => reject(reader.error ?? new Error('Lecture impossible'));
        reader.readAsDataURL(blob);
      }),
  );
}
