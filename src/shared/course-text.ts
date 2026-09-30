import type { PageSection } from './qa';

export interface CourseText {
  url: string;
  title: string;
  sections: PageSection[];
}

/**
 * The text of the course in a frame of the tab (the page, or a course module
 * in a frame): by sections, each under its heading. Run by
 * `chrome.scripting.executeScript` in every frame — self-contained, nothing
 * from outside the function.
 */
export function readCourseText(): CourseText | null {
  const body = document.body;
  if (!body) return null;
  const MAX = 60_000;
  const SKIP =
    'script,style,noscript,template,svg,canvas,video,audio,iframe,object,nav,footer,[role="navigation"],[role="banner"],[role="contentinfo"],[aria-hidden="true"],[hidden],[id^="boo-notes"]';
  const BLOCK = /^(?:P|LI|DIV|SECTION|ARTICLE|TD|TH|DD|DT|BLOCKQUOTE|PRE|FIGCAPTION|SUMMARY|LABEL|H[1-6]|MAIN|ASIDE|BODY)$/;
  const root = document.querySelector('main, [role="main"], article') ?? body;
  const visible = new Map<Element, boolean>();
  const shown = (el: Element): boolean => {
    let v = visible.get(el);
    if (v === undefined) {
      const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
      v = !el.closest(SKIP) && (check ? check.call(el, { visibilityProperty: true }) : true);
      visible.set(el, v);
    }
    return v;
  };
  const isHeading = (el: Element) => /^H[1-6]$/.test(el.tagName) || el.getAttribute('role') === 'heading';
  const sections: PageSection[] = [];
  let heading = '';
  let parts: string[] = [];
  let block: Element | null = null;
  let buffer = '';
  let total = 0;
  const flushBlock = () => {
    const text = buffer.replace(/\s+/g, ' ').trim();
    buffer = '';
    if (!text || !block) return;
    if (isHeading(block) || block.closest('h1,h2,h3,h4,h5,h6,[role="heading"]')) {
      flushSection();
      heading = text.slice(0, 160);
    } else {
      parts.push(text);
      total += text.length;
    }
  };
  const flushSection = () => {
    const text = parts.join(' ').trim();
    if (text) sections.push({ heading, text });
    parts = [];
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && total < MAX; node = walker.nextNode()) {
    const value = node.nodeValue ?? '';
    if (!value.trim()) continue;
    const parent = node.parentElement;
    if (!parent || !shown(parent)) continue;
    let b: Element | null = parent;
    while (b && !BLOCK.test(b.tagName) && b.getAttribute('role') !== 'heading') b = b.parentElement;
    if (b !== block) {
      flushBlock();
      block = b;
    }
    buffer += ` ${value}`;
  }
  flushBlock();
  flushSection();
  if (!sections.length) return null;
  return { url: location.href, title: document.title, sections };
}
