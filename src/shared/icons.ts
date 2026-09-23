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
  home: [
    ['path', { d: 'M4 11l8-7 8 7' }],
    ['path', { d: 'M6 9.5V19a1 1 0 0 0 1 1h3.5v-5h3v5H17a1 1 0 0 0 1-1V9.5' }],
  ],
  graph: [
    ['circle', { cx: '6', cy: '7', r: '2.3' }],
    ['circle', { cx: '18', cy: '6', r: '2.3' }],
    ['circle', { cx: '12', cy: '17', r: '2.6' }],
    ['path', { d: 'M8.2 7.8l2.3 6.9M16.6 8l-3.2 6.8M8.3 6.8l7.4-.6' }],
  ],
  mindmap: [
    ['rect', { x: '9', y: '10', width: '6', height: '4', rx: '1.5' }],
    ['rect', { x: '2.5', y: '4', width: '5', height: '3.2', rx: '1.2' }],
    ['rect', { x: '2.5', y: '16.8', width: '5', height: '3.2', rx: '1.2' }],
    ['rect', { x: '16.5', y: '4', width: '5', height: '3.2', rx: '1.2' }],
    ['rect', { x: '16.5', y: '16.8', width: '5', height: '3.2', rx: '1.2' }],
    ['path', { d: 'M7.5 5.6C10 5.6 9 11 11 11M7.5 18.4C10 18.4 9 13 11 13M16.5 5.6C14 5.6 15 11 13 11M16.5 18.4C14 18.4 15 13 13 13' }],
  ],
  course: [
    ['path', { d: 'M2.5 9L12 4.5 21.5 9 12 13.5z' }],
    ['path', { d: 'M6.5 11v4.5c0 1.4 2.5 3 5.5 3s5.5-1.6 5.5-3V11' }],
    ['path', { d: 'M21.5 9v5' }],
  ],
  list: [['path', { d: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01' }]],
  inbox: [
    ['path', { d: 'M3.5 13.5l2.8-7.7A1.5 1.5 0 0 1 7.7 5h8.6a1.5 1.5 0 0 1 1.4.8l2.8 7.7' }],
    ['path', { d: 'M3.5 13.5V18a1.5 1.5 0 0 0 1.5 1.5h14a1.5 1.5 0 0 0 1.5-1.5v-4.5h-5l-1.5 2.5h-4L8.5 13.5z' }],
  ],
  sidebar: [
    ['rect', { x: '3', y: '4.5', width: '18', height: '15', rx: '3' }],
    ['path', { d: 'M9.5 4.5v15M5.5 8h1.5M5.5 11h1.5' }],
  ],
  chevronDown: [['path', { d: 'M6 9.5l6 6 6-6' }]],
  grip: [['path', { d: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01' }]],
  filter: [['path', { d: 'M4 6h16M7 12h10M10 18h4' }]],
  layers: [
    ['path', { d: 'M12 3.5l9 4.5-9 4.5-9-4.5z' }],
    ['path', { d: 'M3 12.5l9 4.5 9-4.5M3 16.5l9 4.5 9-4.5' }],
  ],
  collapse: [['path', { d: 'M8 4v4H4M16 4v4h4M8 20v-4H4M16 20v-4h4' }]],
  expand: [['path', { d: 'M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4' }]],
  unlink: [
    ['path', { d: 'M10 14a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7l-.8.8' }],
    ['path', { d: 'M14 10a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 0 0 5.7 5.7l.8-.8' }],
    ['path', { d: 'M4 4l16 16' }],
  ],
  star: [['path', { d: 'M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.6L12 16.8l-5.1 2.6 1-5.6-4.1-4 5.7-.8z' }]],
  sparkles: [
    ['path', { d: 'M11 3.5l1.6 4.4 4.4 1.6-4.4 1.6L11 15.5l-1.6-4.4L5 9.5l4.4-1.6z' }],
    ['path', { d: 'M18.5 14l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z' }],
  ],
  arrowLeft: [['path', { d: 'M19 12H5M11 6l-6 6 6 6' }]],
  arrowRight: [['path', { d: 'M5 12h14M13 6l6 6-6 6' }]],
  command: [['path', { d: 'M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z' }]],
  broadcast: [
    ['circle', { cx: '12', cy: '12', r: '2' }],
    ['path', { d: 'M8.5 15.5a5 5 0 0 1 0-7M15.5 8.5a5 5 0 0 1 0 7M5.6 18.4a9 9 0 0 1 0-12.8M18.4 5.6a9 9 0 0 1 0 12.8' }],
  ],
  edit: [
    ['path', { d: 'M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z' }],
    ['path', { d: 'M13.5 6.5l4 4' }],
  ],
  palette: [
    ['path', { d: 'M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.9 1.4-2l-.3-.7c-.5-1.2.4-2.3 1.6-2.3h1.8a4 4 0 0 0 4-4c0-4.4-3.8-8-8.5-8z' }],
    ['circle', { cx: '8', cy: '11', r: '1', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '11.5', cy: '7.5', r: '1', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '15.8', cy: '9.5', r: '1', fill: 'currentColor', stroke: 'none' }],
  ],
  question: [
    ['circle', { cx: '12', cy: '12', r: '9' }],
    ['path', { d: 'M9.6 9.2a2.5 2.5 0 0 1 4.9.8c0 1.7-2.5 2.2-2.5 3.8M12 16.8h.01' }],
  ],
} satisfies Record<string, Shape[]>;

/** Shapes of an icon (for renderers other than the DOM helper, e.g. React). */
export function iconShapes(name: IconName): ReadonlyArray<readonly [tag: 'path' | 'circle' | 'rect', attrs: Record<string, string>]> {
  return ICONS[name] as Shape[];
}

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
