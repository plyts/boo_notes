/**
 * Main-world bridge (runs in the page's own JavaScript world, at
 * document_start):
 *
 * - many web players — podcasts, radios, music and course sites — play
 *   through `new Audio()` elements that are never inserted in the page,
 *   invisible to any DOM query. When such a media starts playing, it is moved
 *   into a hidden <boo-media-dock> so the content script can find it, listen
 *   to it and drive it;
 * - the subtitle files the player downloads itself (YouTube's captions, with
 *   the tokens only the player has; WebVTT / SubRip / TTML files of HLS,
 *   DASH, video.js, Plyr, JW… players) are handed to the content script, which
 *   turns them into the transcript. They are read from a copy of the
 *   response: the player gets its own untouched.
 *
 * Nothing else of the page is touched, and a media in the document keeps
 * playing. Payloads cross to the isolated world as JSON strings (objects do
 * not cross JavaScript worlds).
 */
import { CAPTIONS_EVENT, CAPTIONS_REQUEST_EVENT, isCaptionType, isCaptionUrl, type CaptionFilePayload } from '../shared/caption-bridge';

(() => {
  const KEY = '__booNotesMediaBridge';
  const w = window as Window & { [KEY]?: boolean };
  if (w[KEY]) return;
  w[KEY] = true;

  // --- Off-DOM media ---------------------------------------------------------------------

  let dock: HTMLElement | null = null;
  const dockFor = (): HTMLElement => {
    if (!dock || !dock.isConnected) {
      dock = document.createElement('boo-media-dock');
      dock.hidden = true;
      dock.style.setProperty('display', 'none', 'important');
      dock.setAttribute('aria-hidden', 'true');
      document.documentElement.append(dock);
    }
    return dock;
  };

  const proto = HTMLMediaElement.prototype;
  const play = proto.play;
  proto.play = function (this: HTMLMediaElement, ...args: []) {
    try {
      if (!this.isConnected) dockFor().append(this);
    } catch {
      // Never break the page's player.
    }
    return play.apply(this, args);
  };

  // --- Subtitle files downloaded by the player ------------------------------------------------

  const MAX = 8 * 1024 * 1024;
  /** Last files seen, replayed to a content script that starts after them. */
  const seen: CaptionFilePayload[] = [];

  const hand = (payload: CaptionFilePayload): void => {
    if (!payload.body || payload.body.length > MAX) return;
    const i = seen.findIndex((p) => p.url === payload.url);
    if (i !== -1) seen.splice(i, 1);
    seen.push(payload);
    if (seen.length > 8) seen.shift();
    document.dispatchEvent(new CustomEvent(CAPTIONS_EVENT, { detail: JSON.stringify(payload) }));
  };

  document.addEventListener(CAPTIONS_REQUEST_EVENT, () => {
    for (const p of seen) document.dispatchEvent(new CustomEvent(CAPTIONS_EVENT, { detail: JSON.stringify(p) }));
  });

  const urlOf = (input: RequestInfo | URL): string => {
    try {
      return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    } catch {
      return '';
    }
  };

  const fetch0 = window.fetch;
  if (typeof fetch0 === 'function') {
    window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      const promise = fetch0.call(this ?? window, input, init);
      try {
        const requested = urlOf(input);
        void promise.then(
          (res) => {
            try {
              const url = res.url || requested;
              const type = res.headers.get('content-type');
              if (!res.ok || !(isCaptionUrl(url) || isCaptionType(type))) return;
              const length = Number(res.headers.get('content-length') ?? 0);
              if (length > MAX) return;
              void res
                .clone()
                .text()
                .then((body) => hand({ url, contentType: type ?? '', body, at: Date.now() }))
                .catch(() => undefined);
            } catch {
              // Never break the page's requests.
            }
          },
          () => undefined,
        );
      } catch {
        // Idem.
      }
      return promise;
    } as typeof fetch;
  }

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  const opened = new WeakMap<XMLHttpRequest, string>();
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest['open']>) {
    try {
      opened.set(this, String(args[1]));
    } catch {
      // Idem.
    }
    return xhrOpen.apply(this, args as never);
  } as XMLHttpRequest['open'];
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    try {
      const requested = opened.get(this) ?? '';
      this.addEventListener('load', () => {
        try {
          const url = this.responseURL || requested;
          const type = this.getResponseHeader('content-type');
          if (this.status < 200 || this.status >= 300 || !(isCaptionUrl(url) || isCaptionType(type))) return;
          const r = this.responseType;
          const text =
            r === '' || r === 'text'
              ? this.responseText
              : r === 'json'
                ? JSON.stringify(this.response)
                : r === 'arraybuffer' && this.response instanceof ArrayBuffer && this.response.byteLength <= MAX
                  ? new TextDecoder().decode(this.response)
                  : '';
          if (text) hand({ url, contentType: type ?? '', body: text, at: Date.now() });
        } catch {
          // Idem.
        }
      });
    } catch {
      // Idem.
    }
    return xhrSend.call(this, body);
  };
})();
