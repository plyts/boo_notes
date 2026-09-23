/**
 * DOM helpers for the imperative "islands" (PDF, media, image and text
 * viewers) embedded in the React app.
 */
import { h, icon, type IconName } from '../../../src/shared/icons';

export { h, icon };
export type { IconName };

export function iconButton(name: IconName, label: string, onClick?: (e: MouseEvent) => void): HTMLButtonElement {
  const b = h('button', { type: 'button', class: 'icon-btn', title: label, 'aria-label': label }, icon(name, 18));
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

export interface MenuItem {
  label: string;
  icon?: IconName;
  danger?: boolean;
  disabled?: boolean;
  run(): void;
}

let openMenu: { el: HTMLElement; close(): void } | null = null;

/** Small glass context menu anchored to `anchor` (arrows, Enter, Escape). */
export function showMenu(anchor: HTMLElement, items: Array<MenuItem | 'separator'>): void {
  openMenu?.close();
  const menu = h('div', { class: 'island-menu glass-thick', role: 'menu' });
  const buttons: HTMLButtonElement[] = [];
  for (const item of items) {
    if (item === 'separator') {
      menu.append(h('div', { class: 'island-menu-sep', role: 'separator' }));
      continue;
    }
    const b = h(
      'button',
      { type: 'button', role: 'menuitem', class: `island-menu-item${item.danger ? ' danger' : ''}`, disabled: item.disabled },
      item.icon ? icon(item.icon, 16) : h('span', { class: 'island-menu-space' }),
      h('span', {}, item.label),
    );
    b.addEventListener('click', () => {
      close();
      item.run();
    });
    buttons.push(b);
    menu.append(b);
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mr = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(Math.max(8, r.left), window.innerWidth - mr.width - 8)}px`;
  menu.style.top = `${r.bottom + 6 + mr.height > window.innerHeight ? r.top - mr.height - 6 : r.bottom + 6}px`;
  const onKey = (e: KeyboardEvent) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      anchor.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }
  };
  const onDown = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) close();
  };
  function close() {
    menu.remove();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onDown, true);
    if (openMenu?.el === menu) openMenu = null;
  }
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
  openMenu = { el: menu, close };
  buttons.find((b) => !b.disabled)?.focus();
}
