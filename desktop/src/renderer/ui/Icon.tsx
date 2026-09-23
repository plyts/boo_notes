import { createElement, memo } from 'react';
import { iconShapes, type IconName } from '../../../../src/shared/icons';

export type { IconName };

/** Stroke icon of the shared set (24 × 24 grid, SF Symbols–like weight). */
export const Icon = memo(function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {iconShapes(name).map(([tag, attrs], i) => createElement(tag, { key: i, ...toReact(attrs) }))}
    </svg>
  );
});

function toReact(attrs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) out[k.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] = v;
  return out;
}
