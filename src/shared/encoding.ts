export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `data:${blob.type || 'application/octet-stream'};base64,${bytesToBase64(bytes)}`;
}

export function textToDataUrl(text: string, mime = 'text/markdown'): string {
  return `data:${mime};charset=utf-8;base64,${bytesToBase64(new TextEncoder().encode(text))}`;
}

/** Name usable as a file / folder name on every OS. */
export function safeFileName(name: string, fallback = 'note'): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, '');
  return cleaned || fallback;
}

/** ASCII-only variant (`Vidéo façon` → `Video facon`) for file systems / locales refusing Unicode names. */
export function asciiFileName(name: string, fallback = 'note'): string {
  const ascii = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]+/g, ' ');
  return safeFileName(ascii, fallback);
}
