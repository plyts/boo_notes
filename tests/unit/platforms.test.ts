import { describe, expect, it } from 'vitest';
import {
  detectVideoContext,
  isDeclaredPlatformHost,
  noteSlug,
  readStartTime,
  timestampUrl,
} from '../../src/shared/platforms';

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

  it('never gives look-alike hosts a course-platform identity', () => {
    expect(detectVideoContext('https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ')?.platform).toBe('web');
    expect(detectVideoContext('https://notudemy.com/course/a/learn/lecture/1')?.platform).toBe('web');
    expect(detectVideoContext('https://notion.so.evil.test/Page-0123456789abcdef0123456789abcdef')?.platform).toBe('web');
    expect(detectVideoContext('not a url')).toBeNull();
    expect(detectVideoContext('file:///C:/cours/audio.mp3')).toBeNull();
  });

  it('recognises Notion pages by their id', () => {
    const id = '0123456789abcdef0123456789abcdef';
    expect(detectVideoContext(`https://www.notion.so/acme/Cours-React-${id}?pvs=4`)).toEqual({
      platform: 'notion',
      videoId: id,
      noteId: `notion:${id}`,
      canonicalUrl: `https://www.notion.so/${id}`,
      requiresMedia: true,
    });
    // Peeked page (side peek / centre peek) wins over the database behind it.
    const peek = 'fedcba9876543210fedcba9876543210';
    expect(detectVideoContext(`https://www.notion.so/${id}?v=1&p=${peek}&pm=s`)?.noteId).toBe(`notion:${peek}`);
    // Public pages keep their own origin.
    expect(detectVideoContext(`https://acme.notion.site/Cours-${id.toUpperCase()}`)?.canonicalUrl).toBe(
      `https://acme.notion.site/${id}`,
    );
    expect(detectVideoContext('https://www.notion.so/')).toBeNull();
    expect(detectVideoContext('https://www.notion.so/login')).toBeNull();
  });

  it('keys any other page by URL, without tracking parameters', () => {
    const ctx = detectVideoContext('https://podcast.example.test/ep/12?utm_source=x&season=2&fbclid=abc#player');
    expect(ctx).toEqual({
      platform: 'web',
      videoId: 'podcast.example.test/ep/12?season=2',
      noteId: 'web:podcast.example.test/ep/12?season=2',
      canonicalUrl: 'https://podcast.example.test/ep/12?season=2',
      requiresMedia: true,
    });
    expect(detectVideoContext('https://radio.example.test/live?utm_medium=a')?.canonicalUrl).toBe(
      'https://radio.example.test/live',
    );
  });
});

describe('isDeclaredPlatformHost', () => {
  it('matches the manifest content-script hosts only', () => {
    expect(isDeclaredPlatformHost('www.youtube.com')).toBe(true);
    expect(isDeclaredPlatformHost('acme.udemy.com')).toBe(true);
    expect(isDeclaredPlatformHost('www.notion.so')).toBe(true);
    expect(isDeclaredPlatformHost('acme.notion.site')).toBe(true);
    expect(isDeclaredPlatformHost('podcast.example.test')).toBe(false);
    expect(isDeclaredPlatformHost('youtube.com.evil.test')).toBe(false);
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
    expect(noteSlug('web:podcast.example.test/ep/12?season=2')).toBe('web-podcast-example-test-ep-12-season-2');
  });
});
