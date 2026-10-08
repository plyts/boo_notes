import { describe, expect, it } from 'vitest';
import {
  detectVideoContext,
  hashRoute,
  isDeclaredPlatformHost,
  noteSlug,
  pageNoteId,
  readStartTime,
  timestampUrl,
  withLesson,
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

describe('one note per lesson', () => {
  it('a single-page course: each `#/route` is its own lesson (anchors and fragments are not)', () => {
    expect(hashRoute('#/lessons/abc')).toBe('/lessons/abc');
    expect(hashRoute('#!/module/2/')).toBe('/module/2');
    expect(hashRoute('#/chapitres/3')).toBe('/chapitres/3');
    for (const h of ['', '#', '#/', '#section-2', '#t=42', '#:~:text=hello', '#player']) expect(hashRoute(h)).toBeNull();
    // Not a lesson: a slide of a Storyline player, a page of an app — the page stays one note.
    for (const h of ['#/6WI0Yb7Vrl5/5yDEz1ghPkU', '#/home', '#/search?q=x']) expect(hashRoute(h)).toBeNull();
    const a = detectVideoContext('https://learn.example.test/course/42#/lessons/intro');
    const b = detectVideoContext('https://learn.example.test/course/42#/lessons/hooks?x=1');
    expect(a?.noteId).toBe('web:learn.example.test/course/42#/lessons/intro');
    expect(a?.canonicalUrl).toBe('https://learn.example.test/course/42#/lessons/intro');
    expect(b?.noteId).not.toBe(a?.noteId);
    // An anchor in the page: still the page's note.
    expect(detectVideoContext('https://learn.example.test/course/42#quiz')?.noteId).toBe('web:learn.example.test/course/42');
  });

  it('a lesson of the course module in the page: the page’s note narrowed to it, the page found back from it', () => {
    const page = detectVideoContext('https://academy.example.test/learn/courses/77/module')!;
    const lesson = withLesson(page, { route: '/lessons/hooks', title: 'HookToolset' });
    expect(lesson.noteId).toBe('web:academy.example.test/learn/courses/77/module#lesson/lessons/hooks');
    expect(lesson.canonicalUrl).toBe(page.canonicalUrl);
    expect(withLesson(page, { route: '/lessons/intro', title: 'Intro' }).noteId).not.toBe(lesson.noteId);
    expect(pageNoteId(lesson.noteId)).toBe(page.noteId);
    expect(pageNoteId('youtube:abc')).toBe('youtube:abc');
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
