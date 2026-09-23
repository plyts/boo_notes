import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, isLoopbackWsUrl, normalizeSettings } from '../../src/shared/settings';

describe('normalizeSettings', () => {
  it('returns the defaults for empty input', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.drawerWidth).toBe(360);
  });

  it('clamps the drawer width to 300–500 px', () => {
    expect(normalizeSettings({ drawerWidth: 120 }).drawerWidth).toBe(300);
    expect(normalizeSettings({ drawerWidth: 900 }).drawerWidth).toBe(500);
    expect(normalizeSettings({ drawerWidth: 421.6 }).drawerWidth).toBe(422);
  });

  it('rejects unknown enum values and wrong types', () => {
    const s = normalizeSettings({ layout: 'floating', theme: 42, autoPause: 'yes', captureFormat: 'image/gif' });
    expect(s.layout).toBe('side-by-side');
    expect(s.theme).toBe('auto');
    expect(s.autoPause).toBe(false);
    expect(s.captureFormat).toBe('image/jpeg');
  });

  it('migrates the former replayInPage option', () => {
    expect(normalizeSettings({ replayInPage: false }).pageShortcuts).toBe(false);
    expect(normalizeSettings({ pageShortcuts: true, replayInPage: false }).pageShortcuts).toBe(true);
  });

  it('only keeps loopback desktop endpoints', () => {
    expect(normalizeSettings({ desktopUrl: 'ws://127.0.0.1:9000' }).desktopUrl).toBe('ws://127.0.0.1:9000');
    expect(normalizeSettings({ desktopUrl: 'wss://example.com' }).desktopUrl).toBe(DEFAULT_SETTINGS.desktopUrl);
    expect(isLoopbackWsUrl('ws://localhost:43117')).toBe(true);
    expect(isLoopbackWsUrl('http://localhost:43117')).toBe(false);
    expect(isLoopbackWsUrl('ws://localhost.evil.test')).toBe(false);
  });
});
