/** Circular progress (Activity-ring style), with the percentage for assistive technologies. */
export function Ring({ value, size = 28, stroke = 3.5, color = 'var(--accent)', label }: { value: number; size?: number; stroke?: number; color?: string; label?: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.min(1, Math.max(0, value));
  return (
    <svg
      className="ring"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label ?? `${Math.round(v * 100)} %`}
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity={0.14} strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${c * v} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        className="ring-value"
      />
    </svg>
  );
}

export function Bar({ value, label, color }: { value: number; label?: string; color?: string }) {
  const v = Math.min(1, Math.max(0, value));
  return (
    <span className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)} aria-label={label ?? 'Progression'}>
      <span className="bar-fill" style={{ width: `${v * 100}%`, ...(color ? { background: color } : {}) }} />
    </span>
  );
}
