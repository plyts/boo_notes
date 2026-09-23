import type { ReactNode } from 'react';
import {
  Button as AriaButton,
  Header,
  Keyboard,
  Menu as AriaMenu,
  MenuItem,
  MenuSection,
  MenuTrigger,
  Popover,
  Separator,
  type Placement,
} from 'react-aria-components';
import { Icon, type IconName } from './Icon';

export interface MenuAction {
  id: string;
  label: string;
  icon?: IconName;
  danger?: boolean;
  disabled?: boolean;
  shortcut?: string;
  onAction(): void;
}

export type MenuEntry = MenuAction | 'separator' | { section: string; items: MenuAction[] };

function items(entries: MenuEntry[]): ReactNode[] {
  return entries.map((e, i) => {
    if (e === 'separator') return <Separator key={`sep-${i}`} className="menu-sep" />;
    if ('section' in e) {
      return (
        <MenuSection key={`sec-${e.section}`} className="menu-section">
          <Header className="menu-header">{e.section}</Header>
          {items(e.items)}
        </MenuSection>
      );
    }
    return (
      <MenuItem
        key={e.id}
        id={e.id}
        textValue={e.label}
        isDisabled={e.disabled}
        onAction={e.onAction}
        className={`menu-item${e.danger ? ' danger' : ''}`}
      >
        {e.icon ? <Icon name={e.icon} size={16} /> : <span className="menu-icon-space" />}
        <span className="menu-label">{e.label}</span>
        {e.shortcut ? <Keyboard className="menu-kbd">{e.shortcut}</Keyboard> : null}
      </MenuItem>
    );
  });
}

/** Button opening a glass menu. */
export function MenuButton({
  label,
  icon = 'more',
  entries,
  placement = 'bottom end',
  children,
  className,
}: {
  label: string;
  icon?: IconName;
  entries: MenuEntry[];
  placement?: Placement;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <MenuTrigger>
      <AriaButton aria-label={label} className={className ?? (children ? 'btn btn-glass btn-m' : 'icon-btn icon-btn-m icon-btn-plain')}>
        <Icon name={icon} size={children ? 16 : 18} />
        {children ? <span className="btn-label">{children}</span> : null}
      </AriaButton>
      <Popover placement={placement} offset={6} className="popover glass-thick">
        <AriaMenu className="menu" aria-label={label}>
          {items(entries)}
        </AriaMenu>
      </Popover>
    </MenuTrigger>
  );
}
