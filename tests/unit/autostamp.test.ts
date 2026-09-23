import { describe, expect, it } from 'vitest';
import { shouldAutoStamp } from '../../src/shared/autostamp';

describe('shouldAutoStamp', () => {
  it('stamps the first letter typed on an empty line', () => {
    expect(shouldAutoStamp('', 'L')).toBe(true);
    expect(shouldAutoStamp('   ', 'é')).toBe(true);
  });

  it('waits until Markdown block markers are complete', () => {
    for (const marker of ['#', '-', '*', '>', '`', '|', '[', '!']) expect(shouldAutoStamp('', marker)).toBe(false);
    expect(shouldAutoStamp('', '1')).toBe(false);
    expect(shouldAutoStamp('- ', 'L')).toBe(true);
    expect(shouldAutoStamp('1. ', 'L')).toBe(true);
    expect(shouldAutoStamp('## ', 'T')).toBe(true);
    expect(shouldAutoStamp('> ', 'C')).toBe(true);
    expect(shouldAutoStamp('- [ ] ', 'F')).toBe(true);
    expect(shouldAutoStamp('> - ', 'N')).toBe(true);
  });

  it('keeps task lists intact', () => {
    expect(shouldAutoStamp('- ', '[')).toBe(false);
  });

  it('never stamps lines that already have content', () => {
    expect(shouldAutoStamp('[04:15] ', 'x')).toBe(false);
    expect(shouldAutoStamp('Hello', ' ')).toBe(false);
    expect(shouldAutoStamp('Hello', 'w')).toBe(false);
    expect(shouldAutoStamp('3', ' ')).toBe(false);
  });

  it('ignores whitespace and multi-line input', () => {
    expect(shouldAutoStamp('', ' ')).toBe(false);
    expect(shouldAutoStamp('', 'a\nb')).toBe(false);
  });
});
