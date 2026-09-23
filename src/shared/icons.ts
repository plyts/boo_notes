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
