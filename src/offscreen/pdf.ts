import { base64ToBytes, bytesToBase64 } from '../shared/encoding';
import { PDF_JOB, type PdfJob, type PdfJobReply } from '../shared/pdf-job';
import { buildNotesPdf, type PdfPicture } from '../shared/pdf-notes';
import { timestampUrl } from '../shared/platforms';

/** A stored picture as PNG / JPEG bytes (PDF files take no WebP / GIF: redrawn as JPEG). */
async function pictureOf(dataUrl: string): Promise<PdfPicture | null> {
  const m = /^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  const bytes = base64ToBytes(m[2]);
  if (m[1] === 'png') return { bytes, type: 'png' };
  if (m[1] === 'jpeg' || m[1] === 'jpg') return { bytes, type: 'jpg' };
  const bitmap = await createImageBitmap(new Blob([bytes], { type: `image/${m[1]}` }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  return { bytes: new Uint8Array(await jpeg.arrayBuffer()), type: 'jpg' };
}

async function build(job: PdfJob): Promise<string> {
  const timed = new Set(job.notes.filter((n) => n.timed).map((n) => n.id));
  const bytes = await buildNotesPdf(
    job.notes,
    {
      picture: async (path) => {
        const dataUrl = job.pictures[path];
        return dataUrl ? pictureOf(dataUrl).catch(() => null) : null;
      },
      timeUrl: (note, seconds) => (/^https?:\/\//.test(note.url) && timed.has(note.id) ? timestampUrl(note.url, seconds) : null),
    },
    { title: job.title, date: new Date(job.date) },
  );
  return bytesToBase64(bytes);
}

chrome.runtime.onMessage.addListener((msg: PdfJob, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || msg?.target !== PDF_JOB) return false;
  build(msg).then(
    (base64) => sendResponse({ ok: true, base64 } satisfies PdfJobReply),
    (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) } satisfies PdfJobReply),
  );
  return true;
});
