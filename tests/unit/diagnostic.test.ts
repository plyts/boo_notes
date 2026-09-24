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

  it('the real Databricks lesson (Docebo → launcher → SCORM driver → Rise): everything readable, a lesson to read', () => {
    const cdn = 'https://cdn5.dcbstatic.com/files/d/a/databricks_docebosaas_com/1790301600/i6tr3gi/scorm/8114ff';
    const frame = (frameId: number, url: string, textLength: number, extra: Partial<FrameProbe> = {}): FrameProbe => ({
      frameId, url, top: false, title: '', agent: true, app: false, frames: [], media: [], textLength, bridge: true, ...extra,
    });
    const d: Diagnostic = {
      ...base,
      permissions: { site: true, all: true },
      content: { ...base.content!, blocked: [], moduleFollowed: true, scorm: { version: '1.2', status: 'incomplete', progress: null, score: null, location: '' } },
      frames: [
        { ...top, frames: [{ src: 'https://cdn5.dcbstatic.com/dcd/scormapi_v60/launcher.html', width: 1341, height: 953, reachable: false, sandbox: null, allow: 'autoplay' }], scorm: { api12: false, api2004: false, parent: 'none' } },
        frame(3205, 'https://cdn5.dcbstatic.com/dcd/scormapi_v60/launcher.html', 0, { scorm: { api12: true, api2004: false, parent: 'none' }, frames: [{ src: `${cdn}/scormdriver/indexAPI.html`, width: 1341, height: 953, reachable: true, sandbox: null, allow: '' }] }),
        frame(3206, `${cdn}/scormdriver/indexAPI.html`, 0, { frames: [{ src: `${cdn}/scormcontent/index.html`, width: 1323, height: 953, reachable: true, sandbox: null, allow: '' }] }),
        frame(3207, `${cdn}/scormcontent/index.html`, 9833, { tool: 'Articulate Rise 360' }),
      ],
    };
    const f = findings(d);
    expect(f.filter((x) => x.level === 'error')).toEqual([]);
    expect(f.find((x) => x.text.startsWith('La partie affichée de la leçon'))).toMatchObject({ level: 'ok' });
    expect(f.find((x) => x.text.startsWith('La partie affichée de la leçon'))!.text).toContain('(module Articulate Rise 360)');
    expect(f.some((x) => x.text.includes('Module SCORM 1.2 suivi : incomplete'))).toBe(true);
  });

  it('a video block not loaded yet: says to start it', () => {
    const d: Diagnostic = { ...base, permissions: { site: true, all: true }, content: { ...base.content!, blocked: [] }, frames: [{ ...top, frames: [] }, { ...top, frameId: 7, top: false, url: 'https://cdn.example/scormcontent/index.html', frames: [], textLength: 3000, videoBlocks: 1 }] };
    expect(findings(d).some((x) => x.text.startsWith('1 bloc vidéo dans la leçon, pas encore chargé'))).toBe(true);
  });
});

