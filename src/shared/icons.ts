/**
 * Stroke icons (24×24) built with DOM APIs rather than innerHTML, so they
 * also work on pages enforcing Trusted Types (YouTube).
 */
type Shape = [tag: 'path' | 'circle' | 'rect', attrs: Record<string, string>];

const ICONS = {
  camera: [
    ['path', { d: 'M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z' }],
    ['circle', { cx: '12', cy: '13.5', r: '3.5' }],
  ],
  pin: [
    ['path', { d: 'M9 3h6l-1 6 4 4H6l4-4z' }],
    ['path', { d: 'M12 13v8' }],
  ],
  settings: [
    ['path', { d: 'M4 7h9M17 7h3M4 17h3M11 17h9' }],
    ['circle', { cx: '15', cy: '7', r: '2' }],
    ['circle', { cx: '9', cy: '17', r: '2' }],
  ],
  popout: [
    ['path', { d: 'M14 4h6v6' }],
    ['path', { d: 'M20 4l-8 8' }],
    ['path', { d: 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5' }],
  ],
  dock: [
    ['rect', { x: '3', y: '4', width: '18', height: '16', rx: '2' }],
    ['path', { d: 'M14 4v16' }],
  ],
  export: [
    ['path', { d: 'M12 15V3' }],
    ['path', { d: 'M7 8l5-5 5 5' }],
    ['path', { d: 'M5 15v4a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4' }],
  ],
  close: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
  clock: [
    ['circle', { cx: '12', cy: '12', r: '9' }],
    ['path', { d: 'M12 7v5l3 2' }],
  ],
  replay: [
    ['path', { d: 'M3 12a9 9 0 1 0 3-6.7' }],
    ['path', { d: 'M3 4v5h5' }],
  ],
  copy: [
    ['rect', { x: '8', y: '8', width: '12', height: '12', rx: '2' }],
    ['path', { d: 'M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3' }],
  ],
  download: [
    ['path', { d: 'M12 3v12' }],
    ['path', { d: 'M7 10l5 5 5-5' }],
    ['path', { d: 'M5 20h14' }],
  ],
  desktop: [
    ['rect', { x: '3', y: '4', width: '18', height: '12', rx: '2' }],
    ['path', { d: 'M8 20h8M12 16v4' }],
  ],
  notion: [
    ['rect', { x: '4', y: '3', width: '16', height: '18', rx: '2' }],
    ['path', { d: 'M9 16V8l6 8V8' }],
  ],
  pause: [['path', { d: 'M9 5v14M15 5v14' }]],
  play: [['path', { d: 'M8 5.5v13l10.5-6.5z', fill: 'currentColor' }]],
  share: [
    ['path', { d: 'M12 3v12' }],
    ['path', { d: 'M8 7l4-4 4 4' }],
    ['path', { d: 'M7 11H6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1' }],
  ],
  keyboard: [
    ['rect', { x: '2.5', y: '6', width: '19', height: '12', rx: '2' }],
    ['path', { d: 'M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8' }],
  ],
  check: [['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]],
  alert: [
    ['path', { d: 'M12 4l9 16H3z' }],
    ['path', { d: 'M12 10v4M12 17h.01' }],
  ],
  ghost: [
    ['path', { d: 'M6 20V11a6 6 0 0 1 12 0v9l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5z' }],
    ['circle', { cx: '10', cy: '11', r: '1', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '14', cy: '11', r: '1', fill: 'currentColor', stroke: 'none' }],
  ],
  globe: [
    ['circle', { cx: '12', cy: '12', r: '9' }],
    ['path', { d: 'M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18' }],
  ],
  headphones: [
    ['path', { d: 'M4 15v-3a8 8 0 0 1 16 0v3' }],
    ['rect', { x: '3', y: '14', width: '5', height: '7', rx: '2' }],
    ['rect', { x: '16', y: '14', width: '5', height: '7', rx: '2' }],
  ],
  file: [
    ['path', { d: 'M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7z' }],
    ['path', { d: 'M14 3v4h4M9 13h6M9 17h6' }],
  ],
  video: [
    ['rect', { x: '3', y: '6', width: '13', height: '12', rx: '2' }],
    ['path', { d: 'M16 10l5-3v10l-5-3' }],
  ],
  refresh: [
    ['path', { d: 'M20 11a8 8 0 0 0-14.9-3M4 5v4h4' }],
    ['path', { d: 'M4 13a8 8 0 0 0 14.9 3M20 19v-4h-4' }],
  ],
  folder: [['path', { d: 'M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z' }]],
  search: [
    ['circle', { cx: '11', cy: '11', r: '6.5' }],
    ['path', { d: 'M16 16l4.5 4.5' }],
  ],
  quote: [['path', { d: 'M7 17c-2 0-3-1.5-3-3.5C4 10 6 7.5 9 6.5M17 17c-2 0-3-1.5-3-3.5 0-3.5 2-6 5-7' }]],
  chevronLeft: [['path', { d: 'M15 5l-7 7 7 7' }]],
  chevronRight: [['path', { d: 'M9 5l7 7-7 7' }]],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  minus: [['path', { d: 'M5 12h14' }]],
  eye: [
    ['path', { d: 'M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z' }],
    ['circle', { cx: '12', cy: '12', r: '2.5' }],
  ],
  more: [
    ['circle', { cx: '5.5', cy: '12', r: '1.2' }],
    ['circle', { cx: '12', cy: '12', r: '1.2' }],
    ['circle', { cx: '18.5', cy: '12', r: '1.2' }],
  ],
  trash: [
    ['path', { d: 'M4 7h16M9 7V4.5h6V7M6.5 7l1 12.5h9l1-12.5' }],
    ['path', { d: 'M10 11v5M14 11v5' }],
  ],
  library: [
    ['rect', { x: '4', y: '4', width: '4', height: '16', rx: '1' }],
    ['rect', { x: '10', y: '4', width: '4', height: '16', rx: '1' }],
    ['path', { d: 'M16.5 5.2l3.8-1 3.2 15.5-3.8 1z' }],
  ],
  book: [
    ['path', { d: 'M12 6.5C10 5 7 4.5 3.5 5v13c3.5-.5 6.5 0 8.5 1.5 2-1.5 5-2 8.5-1.5V5C17 4.5 14 5 12 6.5z' }],
    ['path', { d: 'M12 6.5v13' }],
  ],
  highlight: [
    ['path', { d: 'M14.5 4.5l5 5-8 8H6.5v-5z' }],
    ['path', { d: 'M4 20.5h16' }],
  ],
  sun: [
    ['circle', { cx: '12', cy: '12', r: '4' }],
    ['path', { d: 'M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4' }],
  ],
  link: [
    ['path', { d: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1' }],
    ['path', { d: 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1' }],
  ],
  fit: [
    ['path', { d: 'M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4' }],
  ],
  flag: [
    ['path', { d: 'M5 21V4M5 4h11l-2 4 2 4H5' }],
  ],
  image: [
    ['rect', { x: '3', y: '4', width: '18', height: '16', rx: '2' }],
    ['circle', { cx: '9', cy: '10', r: '1.8' }],
    ['path', { d: 'M21 16l-5-5-9 9' }],
  ],
  cards: [
    ['rect', { x: '7', y: '3', width: '14', height: '14', rx: '2' }],
    ['path', { d: 'M17 21H5a2 2 0 0 1-2-2V7' }],
    ['path', { d: 'M11 8h6M11 12h4' }],
  ],
  target: [
    ['circle', { cx: '12', cy: '12', r: '8' }],
    ['circle', { cx: '12', cy: '12', r: '3', fill: 'currentColor', stroke: 'none' }],
  ],
  text: [['path', { d: 'M5 6h14M5 10h14M5 14h10M5 18h7' }]],
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof ICONS;

const SVG_NS = 'http://www.w3.org/2000/svg';

export function icon(name: IconName, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const attrs: Record<string, string> = {
    viewBox: '0 0 24 24',
    width: String(size),
    height: String(size),
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.8',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  for (const [tag, shapeAttrs] of ICONS[name] as Shape[]) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(shapeAttrs)) el.setAttribute(k, v);
    svg.append(el);
  }
  return svg;
}

/** Small `h()` helper: element with attributes and children. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c !== null && c !== undefined) el.append(c);
  return el;
}
