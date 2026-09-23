import type { ReactNode } from 'react';
import {
  Input,
  Label,
  SearchField as AriaSearchField,
  Switch as AriaSwitch,
  Text,
  TextField as AriaTextField,
  ToggleButton,
  ToggleButtonGroup,
  Button as AriaButton,
} from 'react-aria-components';
import { Icon, type IconName } from './Icon';

export function TextField({
  label,
  description,
  value,
  onChange,
  placeholder,
  type = 'text',
  autoFocus,
}: {
  label: string;
  description?: string;
  value: string;
  onChange(v: string): void;
  placeholder?: string;
  type?: string;
  autoFocus?: boolean;
}) {
  return (
    <AriaTextField className="field" value={value} onChange={onChange} type={type} autoFocus={autoFocus}>
      <Label className="field-label">{label}</Label>
      <Input className="input" placeholder={placeholder} spellCheck={false} />
      {description ? (
        <Text slot="description" className="field-desc">
          {description}
        </Text>
      ) : null}
    </AriaTextField>
  );
}

export function SearchField({ value, onChange, placeholder, label, onSubmit }: { value: string; onChange(v: string): void; placeholder: string; label: string; onSubmit?(v: string): void }) {
  return (
    <AriaSearchField className="search" value={value} onChange={onChange} aria-label={label} onSubmit={onSubmit}>
      <Icon name="search" size={15} className="search-icon" />
      <Input className="search-input" placeholder={placeholder} />
      <AriaButton className="search-clear" aria-label="Effacer">
        <Icon name="close" size={12} />
      </AriaButton>
    </AriaSearchField>
  );
}

export function Switch({ isSelected, onChange, children }: { isSelected: boolean; onChange(v: boolean): void; children: ReactNode }) {
  return (
    <AriaSwitch className="switch" isSelected={isSelected} onChange={onChange}>
      <span className="switch-label">{children}</span>
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
    </AriaSwitch>
  );
}

/** Segmented control (iOS-style), single choice. */
export function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange(v: T): void;
  options: Array<{ id: T; label: string; icon?: IconName }>;
}) {
  return (
    <ToggleButtonGroup
      aria-label={label}
      className="segmented"
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[value]}
      onSelectionChange={(keys) => {
        const k = [...keys][0];
        if (k !== undefined) onChange(k as T);
      }}
    >
      {options.map((o) => (
        <ToggleButton key={o.id} id={o.id} className="segment" aria-label={o.icon && !o.label ? o.id : undefined}>
          {o.icon ? <Icon name={o.icon} size={14} /> : null}
          {o.label ? <span>{o.label}</span> : null}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

/** Small coloured chip (kind, status). */
export function Chip({ children, tone = 'neutral', icon }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger'; icon?: IconName }) {
  return (
    <span className={`chip chip-${tone}`}>
      {icon ? <Icon name={icon} size={12} /> : null}
      {children}
    </span>
  );
}
