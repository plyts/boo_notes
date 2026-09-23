import { blobToDataUrl } from '../shared/encoding';

export interface Shot {
  dataUrl: string;
  width: number;
  height: number;
  mime: string;
}

export type FrameProbe = 'ok' | 'not-ready' | 'tainted' | 'blank';

/**
 * Checks, on a tiny thumbnail, that the frame can be read: a cross-origin
 * source without CORS taints the canvas, DRM-protected video draws black.
 */
export function probeFrame(video: HTMLVideoElement): FrameProbe {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return 'not-ready';
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 18;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 'tainted';
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch {
    return 'tainted';
  }
  let max = 0;
  for (let i = 0; i < data.length; i += 4) max = Math.max(max, data[i], data[i + 1], data[i + 2]);
  return max < 12 ? 'blank' : 'ok';
}

/**
 * Grabs the current frame at native resolution through a detached canvas,
 * so none of the page / browser UI ends up in the picture. The frame is
 * drawn synchronously (exact instant); encoding happens asynchronously.
 */
export function captureVideoFrame(video: HTMLVideoElement, mime: string, quality: number): Promise<Shot> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('Canvas indisponible'));
  ctx.drawImage(video, 0, 0, width, height);
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Encodage impossible'))), mime, quality),
  ).then(async (blob) => ({ dataUrl: await blobToDataUrl(blob), width, height, mime: blob.type || mime }));
}

export const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
