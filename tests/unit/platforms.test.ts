import { describe, expect, it } from 'vitest';
import { detectVideoContext, noteSlug, readStartTime, timestampUrl } from '../../src/shared/platforms';

describe('detectVideoContext', () => {
  it('recognises YouTube watch pages and drops extra params', () => {
    expect(detectVideoContext('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL1')).toEqual({
      platform: 'youtube',
      videoId: 'dQw4w9WgXcQ',
      noteId: 'youtube:dQw4w9WgXcQ',
      canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    });
    expect(detectVideoContext('https://m.youtube.com/watch?v=dQw4w9WgXcQ')?.noteId).toBe('youtube:dQw4w9WgXcQ');
    expect(detectVideoContext('https://www.youtube.com/live/dQw4w9WgXcQ')?.noteId).toBe('youtube:dQw4w9WgXcQ');
  });

  it('ignores non-video YouTube pages', () => {
    expect(detectVideoContext('https://www.youtube.com/')).toBeNull();
    expect(detectVideoContext('https://www.youtube.com/results?search_query=x')).toBeNull();
    expect(detectVideoContext('https://www.youtube.com/watch')).toBeNull();
  });

  it('recognises Udemy lectures, including business subdomains', () => {
    const ctx = detectVideoContext('https://acme.udemy.com/course/react-avance/learn/lecture/123456#overview');
    expect(ctx).toEqual({
      platform: 'udemy',
      videoId: 'react-avance/123456',
      noteId: 'udemy:react-avance/123456',
      canonicalUrl: 'https://acme.udemy.com/course/react-avance/learn/lecture/123456',
    });
    expect(detectVideoContext('https://www.udemy.com/course/react-avance/')).toBeNull();
  });

  it('recognises Coursera lectures', () => {
    const ctx = detectVideoContext('https://www.coursera.org/learn/machine-learning/lecture/abc12/gradient-descent?x=1');
    expect(ctx?.noteId).toBe('coursera:machine-learning/abc12');
    expect(ctx?.canonicalUrl).toBe('https://www.coursera.org/learn/machine-learning/lecture/abc12/gradient-descent');
  });

  it('rejects look-alike hosts', () => {
    expect(detectVideoContext('https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(detectVideoContext('https://notudemy.com/course/a/learn/lecture/1')).toBeNull();
    expect(detectVideoContext('not a url')).toBeNull();
  });
});

describe('timestamp links', () => {
  it('builds media-fragment links', () => {
    expect(timestampUrl('https://www.youtube.com/watch?v=abcdefghijk', 255.8)).toBe(
      'https://www.youtube.com/watch?v=abcdefghijk#t=255',
    );
    expect(timestampUrl('https://x.test/a#old', 3)).toBe('https://x.test/a#t=3');
  });

  it('reads start times from the hash or the query', () => {
    expect(readStartTime('https://www.youtube.com/watch?v=abcdefghijk#t=255')).toBe(255);
    expect(readStartTime('https://www.youtube.com/watch?v=abcdefghijk&t=4m15s')).toBe(255);
    expect(readStartTime('https://www.udemy.com/course/a/learn/lecture/1?start=90')).toBe(90);
    expect(readStartTime('https://www.udemy.com/course/a/learn/lecture/1')).toBeNull();
  });
});

describe('noteSlug', () => {
  it('produces file-system safe names', () => {
    expect(noteSlug('youtube:dQw4w9WgXcQ')).toBe('youtube-dQw4w9WgXcQ');
    expect(noteSlug('udemy:react-avancé/123')).toBe('udemy-react-avance-123');
  });
});
