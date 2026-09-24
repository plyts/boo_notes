/**
 * « Hello » of a frame agent holding a media: lets the page find the
 * <iframe> it lives in, and place its picture. A course module nests
 * players several frames deep (LMS → launcher → SCORM driver → content):
 * each frame on the way lifts the hello into its own viewport and passes it
 * up, so the page gets it from its own <iframe>, with where the media's
 * frame sits inside it.
 */

/** `p ↦ (x + sx·p.x, y + sy·p.y)`: from the media frame's viewport to the sender's. */
export interface FrameMap {
  x: number;
  y: number;
  sx: number;
  sy: number;
}

export interface FrameHello {
  booNotesFrame: string;
  map: FrameMap;
  /** Viewport of the sending window (the one the map leads to). */
  view: { w: number; h: number };
}

const IDENTITY: FrameMap = { x: 0, y: 0, sx: 1, sy: 1 };

export function frameHello(token: string): FrameHello {
  return { booNotesFrame: token, map: IDENTITY, view: { w: innerWidth, h: innerHeight } };
}

export function readHello(data: unknown): FrameHello | null {
  const d = data as Partial<FrameHello> | null;
  if (!d || typeof d.booNotesFrame !== 'string') return null;
  const m = d.map;
  const map = m && [m.x, m.y, m.sx, m.sy].every((n) => typeof n === 'number' && Number.isFinite(n)) ? m : IDENTITY;
  const v = d.view;
  const view = v && typeof v.w === 'number' && typeof v.h === 'number' ? v : { w: 0, h: 0 };
  return { booNotesFrame: d.booNotesFrame, map, view };
}

/** The map of a hello received from the window of `iframe`, into this window's viewport. */
export function liftMap(hello: FrameHello, iframe: HTMLIFrameElement): FrameMap {
  const r = iframe.getBoundingClientRect();
  // CSS scaling of the iframe itself, then of its viewport into its box (zoom).
  const tx = iframe.offsetWidth ? r.width / iframe.offsetWidth : 1;
  const ty = iframe.offsetHeight ? r.height / iframe.offsetHeight : 1;
  const kx = hello.view.w && iframe.clientWidth ? iframe.clientWidth / hello.view.w : 1;
  const ky = hello.view.h && iframe.clientHeight ? iframe.clientHeight / hello.view.h : 1;
  const sx = tx * kx;
  const sy = ty * ky;
  const left = r.left + iframe.clientLeft * tx;
  const top = r.top + iframe.clientTop * ty;
  const m = hello.map;
  return { x: left + sx * m.x, y: top + sy * m.y, sx: sx * m.sx, sy: sy * m.sy };
}

/** The hello passed up to the parent window. */
export function liftHello(hello: FrameHello, iframe: HTMLIFrameElement): FrameHello {
  return { booNotesFrame: hello.booNotesFrame, map: liftMap(hello, iframe), view: { w: innerWidth, h: innerHeight } };
}
