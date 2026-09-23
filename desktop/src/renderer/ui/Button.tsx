import type { ReactNode } from 'react';
import {
  Button as AriaButton,
  Tooltip,
  TooltipTrigger,
  type ButtonProps as AriaButtonProps,
} from 'react-aria-components';
import { Icon, type IconName } from './Icon';

export type Variant = 'primary' | 'glass' | 'plain' | 'danger' | 'tinted';

export interface ButtonProps extends Omit<AriaButtonProps, 'children' | 'className'> {
  variant?: Variant;
  size?: 's' | 'm' | 'l';
  icon?: IconName;
  children?: ReactNode;
  className?: string;
}

/** Capsule button (Liquid Glass): tinted for the main action, glass otherwise. */
export function Button({ variant = 'glass', size = 'm', icon, children, className, ...props }: ButtonProps) {
  return (
    <AriaButton {...props} className={['btn', `btn-${variant}`, `btn-${size}`, className].filter(Boolean).join(' ')}>
      {icon ? <Icon name={icon} size={size === 's' ? 14 : 16} /> : null}
      {children !== undefined ? <span className="btn-label">{children}</span> : null}
    </AriaButton>
  );
}

export interface IconButtonProps extends Omit<AriaButtonProps, 'children' | 'className'> {
  icon: IconName;
  /** Accessible name, also shown as a tooltip. */
  label: string;
  shortcut?: string;
  size?: 's' | 'm';
  variant?: 'plain' | 'glass';
  className?: string;
  tooltip?: boolean;
}

export function IconButton({ icon, label, shortcut, size = 'm', variant = 'plain', className, tooltip = true, ...props }: IconButtonProps) {
  const button = (
    <AriaButton {...props} aria-label={label} className={['icon-btn', `icon-btn-${size}`, `icon-btn-${variant}`, className].filter(Boolean).join(' ')}>
      <Icon name={icon} size={size === 's' ? 15 : 18} />
    </AriaButton>
  );
  if (!tooltip) return button;
  return (
    <TooltipTrigger delay={500} closeDelay={80}>
      {button}
      <Tooltip className="tooltip glass-thick" offset={8}>
        {label}
        {shortcut ? <kbd className="tooltip-kbd">{shortcut}</kbd> : null}
      </Tooltip>
    </TooltipTrigger>
  );
}
