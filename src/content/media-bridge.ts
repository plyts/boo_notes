/**
 * Main-world bridge (runs in the page's own JavaScript world, at
 * document_start): many web players — podcasts, radios, music and course
 * sites — play through `new Audio()` elements that are never inserted in the
 * page, invisible to any DOM query. When such a media starts playing, it is
 * moved into a hidden <boo-media-dock> so the content script can find it,
 * listen to it and drive it. Nothing else of the page is touched, and a
 * media in the document keeps playing.
 */
(() => {
  const KEY = '__booNotesMediaBridge';
  const w = window as Window & { [KEY]?: boolean };
  if (w[KEY]) return;
  w[KEY] = true;

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
})();
