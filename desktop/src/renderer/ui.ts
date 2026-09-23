import { h, icon, type IconName } from '../../../src/shared/icons';
import type { MediaKind } from '../core/types';

export { h, icon };
export type { IconName };

export const KIND_ICON: Record<MediaKind, IconName> = {
  video: 'video',
  audio: 'headphones',
  pdf: 'file',
  text: 'text',
  image: 'image',
  page: 'globe',
  note: 'cards',
};

export function button(
  label: string,
  opts: { icon?: IconName; variant?: 'primary' | 'ghost' | 'danger' | 'plain'; title?: string; small?: boolean } = {},
  onClick?: (e: MouseEvent) => void,
): HTMLButtonElement {
  const b = h(
    'button',
    {
      type: 'button',
      class: ['btn', opts.variant ?? 'plain', opts.small ? 'small' : ''].filter(Boolean).join(' '),
      title: opts.title,
    },
    opts.icon ? icon(opts.icon, 16) : null,
    label ? h('span', {}, label) : null,
  );
  if (!label && opts.title) b.setAttribute('aria-label', opts.title);
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

export function iconButton(name: IconName, label: string, onClick?: (e: MouseEvent) => void): HTMLButtonElement {
  const b = h('button', { type: 'button', class: 'icon-btn', title: label, 'aria-label': label }, icon(name, 18));
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

// --- Toasts -----------------------------------------------------------------------------------

let toastHost: HTMLElement | null = null;

export function toast(text: string, kind: 'info' | 'success' | 'error' = 'info', action?: { label: string; run(): void }): void {
  toastHost ??= document.body.appendChild(h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }));
  const el = h(
    'div',
    { class: `toast ${kind}` },
    icon(kind === 'error' ? 'alert' : kind === 'success' ? 'check' : 'ghost', 16),
    h('span', {}, text),
  );
  if (action) {
    el.append(
      button(action.label, { variant: 'ghost', small: true }, () => {
        action.run();
        el.remove();
      }),
    );
  }
  toastHost.append(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 250);
  }, kind === 'error' ? 6000 : 3200);
}

export function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // Errors crossing IPC are prefixed by Electron.
  return msg.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

// --- Menus --------------------------------------------------------------------------------------

export interface MenuItem {
  label: string;
  icon?: IconName;
  danger?: boolean;
  checked?: boolean;
  disabled?: boolean;
  run(): void;
}

let openMenu: { el: HTMLElement; close(): void } | null = null;

/** Popover menu anchored to `anchor` (keyboard: arrows, Enter, Escape). */
export function showMenu(anchor: HTMLElement, items: Array<MenuItem | 'separator'>): void {
  openMenu?.close();
  const menu = h('div', { class: 'menu', role: 'menu' });
  const buttons: HTMLButtonElement[] = [];
  for (const item of items) {
    if (item === 'separator') {
      menu.append(h('div', { class: 'menu-sep', role: 'separator' }));
      continue;
    }
    const b = h(
      'button',
      {
        type: 'button',
        role: item.checked === undefined ? 'menuitem' : 'menuitemradio',
        'aria-checked': item.checked === undefined ? undefined : String(item.checked),
        class: `menu-item${item.danger ? ' danger' : ''}`,
        disabled: item.disabled,
      },
      item.icon ? icon(item.icon, 16) : h('span', { class: 'menu-icon-space' }),
      h('span', {}, item.label),
      item.checked ? icon('check', 14) : null,
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
  const left = Math.min(Math.max(8, r.right - mr.width), window.innerWidth - mr.width - 8);
  const top = r.bottom + 6 + mr.height > window.innerHeight ? r.top - mr.height - 6 : r.bottom + 6;
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.max(8, top)}px`;
  anchor.setAttribute('aria-expanded', 'true');

  const onKey = (e: KeyboardEvent) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      anchor.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const enabled = buttons.filter((b) => !b.disabled);
      const j = enabled.indexOf(buttons[i]);
      const next = enabled[(j + (e.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length];
      next?.focus();
    }
  };
  const onDown = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node)) close();
  };
  function close() {
    menu.remove();
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onDown, true);
    if (openMenu?.el === menu) openMenu = null;
  }
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
  openMenu = { el: menu, close };
  buttons.find((b) => !b.disabled)?.focus();
}

// --- Dialogs --------------------------------------------------------------------------------------

export function confirmDialog(opts: {
  title: string;
  text: string;
  confirm: string;
  danger?: boolean;
  checkbox?: string;
}): Promise<{ ok: boolean; checked: boolean }> {
  return new Promise((resolve) => {
    const check = opts.checkbox ? h('input', { type: 'checkbox' }) : null;
    const dialog = h(
      'dialog',
      { class: 'dialog' },
      h('h2', {}, opts.title),
      h('p', {}, opts.text),
      check ? h('label', { class: 'check' }, check, h('span', {}, opts.checkbox)) : null,
    );
    const done = (ok: boolean) => {
      dialog.close();
      dialog.remove();
      resolve({ ok, checked: Boolean(check?.checked) });
    };
    dialog.append(
      h(
        'div',
        { class: 'dialog-actions' },
        button('Annuler', { variant: 'plain' }, () => done(false)),
        button(opts.confirm, { variant: opts.danger ? 'danger' : 'primary' }, () => done(true)),
      ),
    );
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      done(false);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

/** Asks for a short text (title of a new sheet…); null when cancelled. */
export function promptDialog(opts: { title: string; text?: string; placeholder?: string; value?: string; confirm: string }): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', class: 'dialog-input', placeholder: opts.placeholder, value: opts.value ?? '', 'aria-label': opts.title });
    const dialog = h('dialog', { class: 'dialog' }, h('h2', {}, opts.title), opts.text ? h('p', {}, opts.text) : null, input);
    const done = (value: string | null) => {
      dialog.close();
      dialog.remove();
      resolve(value?.trim() ? value.trim() : null);
    };
    const ok = button(opts.confirm, { variant: 'primary' }, () => done(input.value));
    dialog.append(h('div', { class: 'dialog-actions' }, button('Annuler', { variant: 'plain' }, () => done(null)), ok));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        done(input.value);
      }
    });
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      done(null);
    });
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
  });
}

// --- Formatting ---------------------------------------------------------------------------------

const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });

export function relativeTime(ts: number, now = Date.now()): string {
  const s = Math.round((ts - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return 'à l’instant';
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(s / 3600), 'hour');
  if (abs < 7 * 86_400) return rtf.format(Math.round(s / 86_400), 'day');
  return new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function percent(ratio: number): string {
  return `${Math.round(ratio * 100)} %`;
}

export function duration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
}

export function progressBar(ratio: number, label?: string): HTMLElement {
  const bar = h('span', {
    class: 'progress',
    role: 'progressbar',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    'aria-valuenow': String(Math.round(ratio * 100)),
    'aria-label': label ?? 'Progression',
  });
  const fill = h('span', { class: 'progress-fill' });
  fill.style.width = `${Math.round(ratio * 1000) / 10}%`;
  bar.append(fill);
  return bar;
}
