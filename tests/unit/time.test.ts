import { describe, expect, it } from 'vitest';
import { formatTimecode, parseTimeParam, parseTimecode } from '../../src/shared/time';

describe('formatTimecode', () => {
  it('pads minutes and seconds', () => {
    expect(formatTimecode(0)).toBe('00:00');
    expect(formatTimecode(255)).toBe('04:15');
    expect(formatTimecode(255.9)).toBe('04:15');
  });
  it('adds hours past one hour', () => {
    expect(formatTimecode(3723)).toBe('1:02:03');
  });
  it('treats invalid values as zero', () => {
    expect(formatTimecode(Number.NaN)).toBe('00:00');
    expect(formatTimecode(-5)).toBe('00:00');
  });
});

describe('parseTimecode', () => {
  it('round-trips formatted values', () => {
    for (const s of [0, 59, 255, 3599, 3600, 3723, 40000]) expect(parseTimecode(formatTimecode(s))).toBe(s);
  });
  it('accepts long minute counts without hours', () => {
    expect(parseTimecode('75:00')).toBe(4500);
  });
  it('rejects malformed values', () => {
    expect(parseTimecode('4:75')).toBeNull();
    expect(parseTimecode('1:60:00')).toBeNull();
    expect(parseTimecode('abc')).toBeNull();
  });
});

describe('parseTimeParam', () => {
  it('understands the usual t= formats', () => {
    expect(parseTimeParam('255')).toBe(255);
    expect(parseTimeParam('255s')).toBe(255);
    expect(parseTimeParam('255.7')).toBe(255);
    expect(parseTimeParam('4m15s')).toBe(255);
    expect(parseTimeParam('1h2m3s')).toBe(3723);
    expect(parseTimeParam('04:15')).toBe(255);
    expect(parseTimeParam('')).toBeNull();
    expect(parseTimeParam('soon')).toBeNull();
  });
});
