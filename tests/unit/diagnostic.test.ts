import { describe, expect, it } from 'vitest';
import { bareUrl, findings, reportText, type Diagnostic, type FrameProbe } from '../../src/shared/diagnostic';

const top: FrameProbe = {
  frameId: 0,
  url: 'https://customer-academy.databricks.com/learn/courses/2971/lessons/63328:4384/overview',
  top: true,
  title: 'Course Project',
  agent: false,
  app: true,
  frames: [{ src: '(sans adresse)', width: 1100, height: 640, reachable: false, sandbox: null, allow: 'fullscreen' }],
  media: [],
  textLength: 900,
  scorm: { api12: false, api2004: true, parent: 'none' },
  bridge: true,
};

const base: Diagnostic = {
  at: Date.UTC(2026, 8, 24),
  version: '1.0.0',
  browser: 'Chrome/141.0',
  tab: { url: top.url, title: 'Course Project' },
  permissions: { site: false, all: false },
  content: { context: { platform: 'web', noteId: 'web:x' }, mode: 'page', source: null, media: null, mediaFrames: 0, blocked: ['*'], moduleFollowed: false, scorm: null, notesOpen: true, popout: false, errors: [] },
  injectError: null,
  frames: [top],
  sync: { desktop: 'offline', notion: 'connecté' },
};

describe('page diagnostic', () => {
  it('names the frame Boo Notes cannot read (hidden address) and the missing right', () => {
    const f = findings(base);
    expect(f[0]).toEqual({ level: 'ok', text: 'Boo Notes est actif sur cette page, notes ouvertes.' });
    expect(f.find((x) => x.level === 'error')?.text).toContain('1 cadre de la page (adresse masquée)');
    expect(f.some((x) => x.text.includes('Interface SCORM du LMS trouvée'))).toBe(true);
    expect(reportText(base)).toContain('#0 [page] https://customer-academy.databricks.com/learn/courses/2971/lessons/63328:4384/overview · Boo Notes ✓ · SCORM 2004');
  });

  it('says when Boo Notes could not start in the tab', () => {
    const f = findings({ ...base, content: null, injectError: 'Cannot access contents of the page' });
    expect(f[0].level).toBe('error');
    expect(f[0].text).toContain('Cannot access contents of the page');
  });

  it('a followed video in a frame: all set', () => {
    const f = findings({ ...base, permissions: { site: true, all: true }, frames: [{ ...top, frames: [] }], content: { ...base.content!, source: 'frame', mode: 'video', blocked: [] } });
    expect(f.filter((x) => x.level === 'error')).toEqual([]);
    expect(f.some((x) => x.text.startsWith('Vidéo suivie dans un cadre'))).toBe(true);
  });

  it('keeps addresses without their query', () => {
    expect(bareUrl('https://lms.example.com/launch?token=secret#t=3')).toBe('https://lms.example.com/launch');
  });
});
