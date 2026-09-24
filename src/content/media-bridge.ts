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
 * - a course module (SCORM 1.2 / 2004) talks to its LMS through the `API` /
 *   `API_1484_11` object of a parent window, an xAPI one posts statements:
 *   their completion, progress, score and bookmark are handed over too, for
 *   the notes (the calls themselves go through untouched).
 *
 * Nothing else of the page is touched, and a media in the document keeps
 * playing. Payloads cross to the isolated world as JSON strings (objects do
 * not cross JavaScript worlds).
 */
import { CAPTIONS_EVENT, CAPTIONS_REQUEST_EVENT, isCaptionType, isCaptionUrl, type CaptionFilePayload } from '../shared/caption-bridge';
import { SCORM_EVENT, SCORM_KEYS, SCORM_REQUEST_EVENT, xapiValues, type ScormValue } from '../shared/scorm';

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

  // --- Course modules (SCORM, xAPI) -----------------------------------------------------------

  const scormSeen = new Map<string, ScormValue>();
  const scormHand = (v: ScormValue): void => {
    if (!SCORM_KEYS.test(v.key)) return;
    const value = { ...v, value: String(v.value ?? '').slice(0, 500) };
    scormSeen.set(v.key, value);
    document.dispatchEvent(new CustomEvent(SCORM_EVENT, { detail: JSON.stringify(value) }));
  };
  document.addEventListener(SCORM_REQUEST_EVENT, () => {
    for (const v of scormSeen.values()) document.dispatchEvent(new CustomEvent(SCORM_EVENT, { detail: JSON.stringify(v) }));
  });

  const wrapped = new WeakSet<object>();
  /** Follows the values a module sets on the LMS's API object (the call goes through unchanged). */
  const wrapApi = (api: unknown, version: '1.2' | '2004'): void => {
    if (!api || typeof api !== 'object' || wrapped.has(api)) return;
    wrapped.add(api);
    const o = api as Record<string, unknown>;
    const [setName, getName, initName] = version === '2004' ? ['SetValue', 'GetValue', 'Initialize'] : ['LMSSetValue', 'LMSGetValue', 'LMSInitialize'];
    const set = o[setName];
    const get = o[getName];
    const init = o[initName];
    try {
      if (typeof set === 'function') {
        o[setName] = function (this: unknown, ...args: unknown[]) {
          const result = (set as (...a: unknown[]) => unknown).apply(this, args);
          try {
            scormHand({ version, key: String(args[0]), value: String(args[1]) });
          } catch {
            // Never break the module.
          }
          return result;
        };
      }
      // A module resumed: its saved values, read right after it starts.
      if (typeof init === 'function' && typeof get === 'function') {
        o[initName] = function (this: unknown, ...args: unknown[]) {
          const result = (init as (...a: unknown[]) => unknown).apply(this, args);
          try {
            const keys = version === '2004' ? ['cmi.completion_status', 'cmi.success_status', 'cmi.progress_measure', 'cmi.score.raw', 'cmi.location'] : ['cmi.core.lesson_status', 'cmi.core.score.raw', 'cmi.core.lesson_location'];
            for (const key of keys) {
              const value = (get as (k: string) => unknown).call(api, key);
              if (value !== undefined && value !== null && value !== '') scormHand({ version, key, value: String(value) });
            }
          } catch {
            // Idem.
          }
          return result;
        };
      }
    } catch {
      // A frozen object: nothing to follow.
    }
  };
  const scanApis = (): void => {
    try {
      const g = window as unknown as { API?: unknown; API_1484_11?: unknown };
      wrapApi(g.API, '1.2');
      wrapApi(g.API_1484_11, '2004');
    } catch {
      // Idem.
    }
  };
  scanApis();
  // The LMS creates its API object when the module is opened.
  let scans = 0;
  const scanTimer = setInterval(() => {
    scanApis();
    if (++scans > 600) clearInterval(scanTimer);
  }, 1000);

  /** xAPI statements posted by a module: `{ verb, result }`. */
  const readStatements = (url: string, body: unknown): void => {
    try {
      if (!/\/statements(?:[?/]|$)/.test(url) || typeof body !== 'string' || body.length > 1_000_000) return;
      for (const v of xapiValues(JSON.parse(body))) scormHand(v);
    } catch {
      // Not JSON, or not xAPI.
    }
  };

  const fetch0 = window.fetch;
  if (typeof fetch0 === 'function') {
    window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      if (init?.body && /^(POST|PUT)$/i.test(init.method ?? '')) readStatements(urlOf(input), init.body);
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
      if (body) readStatements(requested, body);
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
