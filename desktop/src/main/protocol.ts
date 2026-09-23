import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import { net, protocol } from 'electron';
import type { Library } from '../core/library';

/**
 * `boo://app/` serves the UI, the media being studied
 * (`boo://app/__media/<resource id>`: local files, and streams added by
 * address, with Range support for seeking) and the
 * vault captures (`boo://app/__vault/assets/…`). A dedicated scheme gives the
 * UI a real origin (CSP, ES module workers) without exposing the file system.
 */
export const SCHEME = 'boo';

export function registerSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true },
    },
  ]);
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.weba': 'audio/webm',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
};

const notFound = () => new Response('Not found', { status: 404 });

/** Streams a file, honouring a `Range: bytes=a-b` header. */
export async function fileResponse(path: string, range: string | null, extraHeaders: Record<string, string> = {}): Promise<Response> {
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) return notFound();
    size = info.size;
  } catch {
    return notFound();
  }
  const type = TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    end = Math.min(end, size - 1);
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    start = Math.max(0, start);
    const body = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
    return new Response(body, {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        ...extraHeaders,
      },
    });
  }
  const body = Readable.toWeb(createReadStream(path)) as ReadableStream;
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes', ...extraHeaders },
  });
}

/** A remote media relayed to the UI, honouring Range requests (seeking). */
async function remoteResponse(url: string, range: string | null): Promise<Response> {
  if (!/^https?:\/\//i.test(url)) return notFound();
  const upstream = await net.fetch(url, { headers: range ? { Range: range } : {} });
  const headers = new Headers();
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

export function handleScheme(rendererDir: string, getLibrary: () => Library): void {
  const root = normalize(rendererDir);
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const range = request.headers.get('range');
    try {
      switch (url.host) {
        case 'app': {
          // Media and captures share the UI origin: frames of a video can be captured (untainted canvas).
          if (path.startsWith('__media/')) {
            const res = getLibrary().getResource(path.slice('__media/'.length));
            if (!res) return notFound();
            if (res.origin === 'file') return fileResponse(res.source, range);
            // A stream / remote file added by address: relayed (Range included) under the UI origin,
            // so frames can be captured. Only addresses stored in the library are relayed.
            if (res.origin === 'url') return remoteResponse(res.source, range);
            return notFound();
          }
          if (path.startsWith('__vault/')) return fileResponse(getLibrary().assetPath(path.slice('__vault/'.length)), range);
          const file = normalize(join(root, path || 'index.html'));
          if (!file.startsWith(root + sep)) return notFound();
          return fileResponse(file, range, { 'Cache-Control': 'no-cache' });
        }
        default:
          return notFound();
      }
    } catch {
      return notFound();
    }
  });
}
