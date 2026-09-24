import { passageCard, recordBlocker, Recording } from '../../../../src/content/recorder';
import type { Shot } from '../../../../src/content/capture';

/**
 * Passages of a local video or audio in the app: the same recording as the
 * browser extension (captureStream + MediaRecorder), played by the app's own
 * player.
 */
export { passageCard, recordBlocker, Recording };
export type { Shot };

/** Seeks and waits until the new frame is shown (or 4 s). */
export function seekTo(media: HTMLMediaElement, seconds: number): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(media.currentTime - seconds) < 0.05 && media.readyState >= 2) {
      resolve();
      return;
    }
    const timer = setTimeout(done, 4000);
    function done() {
      clearTimeout(timer);
      media.removeEventListener('seeked', done);
      resolve();
    }
    media.addEventListener('seeked', done);
    media.currentTime = seconds;
  });
}

/** Current frame of a video as a JPEG data URL (null for audio / not ready). */
export function frameOf(media: HTMLMediaElement): string | null {
  if (!(media instanceof HTMLVideoElement) || !media.videoWidth) return null;
  const canvas = document.createElement('canvas');
  canvas.width = media.videoWidth;
  canvas.height = media.videoHeight;
  canvas.getContext('2d')?.drawImage(media, 0, 0);
  try {
    return canvas.toDataURL('image/jpeg', 0.88);
  } catch {
    return null;
  }
}

/** Replays [start, end] and records it; the user keeps writing meanwhile. */
export async function recordRange(media: HTMLMediaElement, start: number, end: number): Promise<{ blob: Blob; mime: string; poster: string | null }> {
  const blocker = recordBlocker(media);
  if (blocker) throw new Error(blocker);
  media.pause();
  await seekTo(media, start);
  const poster = frameOf(media);
  const rec = new Recording(media, media instanceof HTMLVideoElement && media.videoWidth ? 'video' : 'audio');
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      media.removeEventListener('timeupdate', onTime);
      media.removeEventListener('pause', onPause);
      media.removeEventListener('play', onPlay);
    };
    const onTime = () => {
      const t = media.currentTime;
      if (t >= end) {
        cleanup();
        media.pause();
        rec.stop().then((blob) => resolve({ blob, mime: rec.mime, poster }), reject);
      } else if (t < start - 2 || t > end + 5) {
        cleanup();
        void rec.stop().catch(() => undefined);
        reject(new Error('enregistrement annulé (lecture déplacée)'));
      }
    };
    const onPause = () => rec.pause();
    const onPlay = () => rec.resume();
    media.addEventListener('timeupdate', onTime);
    media.addEventListener('pause', onPause);
    media.addEventListener('play', onPlay);
    void media.play().catch((e: unknown) => {
      cleanup();
      void rec.stop().catch(() => undefined);
      reject(e instanceof Error ? e : new Error(String(e)));
    });
  });
}
