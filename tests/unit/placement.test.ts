import { describe, expect, it } from 'vitest';
import { areaBeside, clampBox, dockZone, normalizePlace, resizeBox, splitRatio, splitSize, UNBOUNDED } from '../../src/shared/placement';
import { followBorder, notesShare, sameBounds, tileBounds, tileChoice, TILES } from '../../src/shared/tiling';
import { within } from '../../src/background/tiling';
import { normalizeSettings } from '../../src/shared/settings';

describe('placement du panneau', () => {
  it('une place enregistrée est relue telle quelle, une place abîmée retombe sur le défaut', () => {
    const fallback = { mode: 'dock', side: 'right' } as const;
    expect(normalizePlace({ mode: 'float', side: 'left', float: { x: 10.4, y: 20, w: 400, h: 500 }, mini: null, glass: 0.7 }, fallback)).toEqual({
      mode: 'float',
      side: 'left',
      float: { x: 10, y: 20, w: 400, h: 500 },
      mini: null,
      glass: 0.7,
    });
    expect(normalizePlace({ mode: 'nope', side: 'middle', float: { x: 'a' }, glass: 5 }, fallback)).toEqual({ mode: 'dock', side: 'right', float: null, mini: null, glass: 0.9 });
    expect(normalizePlace(null, { mode: 'float', side: 'bottom' })).toMatchObject({ mode: 'float', side: 'bottom', glass: 0.55 });
  });

  it('une boîte reste entière dans la fenêtre, jamais plus grande qu’elle', () => {
    expect(clampBox({ x: 1300, y: -40, w: 400, h: 300 }, 1400, 900)).toEqual({ x: 1000, y: 0, w: 400, h: 300 });
    expect(clampBox({ x: 10, y: 10, w: 2000, h: 1200 }, 1400, 900)).toEqual({ x: 0, y: 0, w: 1400, h: 900 });
    expect(clampBox({ x: 10, y: 10, w: 100, h: 50 }, 1400, 900, { w: 300, h: 240 })).toEqual({ x: 10, y: 10, w: 300, h: 240 });
  });

  it('ses bords la redimensionnent : le bord opposé ne bouge pas, la taille minimale tient', () => {
    const start = { x: 500, y: 200, w: 400, h: 500 };
    const min = { w: 300, h: 240 };
    expect(resizeBox(start, 'w', -120, 0, 1400, 900, min)).toEqual({ x: 380, y: 200, w: 520, h: 500 });
    expect(resizeBox(start, 'se', 50, 80, 1400, 900, min)).toEqual({ x: 500, y: 200, w: 450, h: 580 });
    // Narrowed past its minimum: stops there, its right edge still put.
    expect(resizeBox(start, 'w', 300, 0, 1400, 900, min)).toEqual({ x: 600, y: 200, w: 300, h: 500 });
    // Out of the window: stops at its edge.
    expect(resizeBox(start, 'n', 0, -400, 1400, 900, min)).toEqual({ x: 500, y: 0, w: 400, h: 700 });
  });

  it('contre un bord (40 px), la zone d’ancrage de ce bord ; ailleurs, aucune', () => {
    expect(dockZone(12, 400, 1400, 900)).toBe('left');
    expect(dockZone(1390, 400, 1400, 900)).toBe('right');
    expect(dockZone(700, 10, 1400, 900)).toBe('top');
    expect(dockZone(700, 880, 1400, 900)).toBe('bottom');
    expect(dockZone(700, 400, 1400, 900)).toBeNull();
    // In a corner: the nearest edge.
    expect(dockZone(5, 30, 1400, 900)).toBe('left');
    // In fullscreen, only the left or the right.
    expect(dockZone(700, 10, 1400, 900, ['left', 'right'])).toBeNull();
  });

  it('plein écran : 70 / 30 par défaut, le partage borné, la vidéo jamais écrasée', () => {
    expect(splitSize(1400, 0.7, 300, 160)).toBe(420);
    expect(splitSize(1400, 0.6, 300, 160)).toBe(560);
    // Never under the notes' minimum, never more than the room left to the video.
    expect(splitSize(800, 0.85, 300, 160)).toBe(300);
    expect(splitRatio(1400, 560)).toBe(0.6);
    expect(splitRatio(1400, 1300)).toBe(0.4);
    expect(splitRatio(1400, 50)).toBe(0.85);
  });

  it('la part de la page à côté des notes, selon leur bord', () => {
    const notes = { left: 1040, top: 56, right: 1400, bottom: 900 };
    expect(areaBeside(notes, 'right', 1400, 900, false)).toEqual({ left: -UNBOUNDED, top: -UNBOUNDED, right: 1032, bottom: UNBOUNDED });
    expect(areaBeside({ left: 0, top: 56, right: 360, bottom: 900 }, 'left', 1400, 900, false)).toEqual({ left: 368, top: -UNBOUNDED, right: 1400, bottom: UNBOUNDED });
    expect(areaBeside({ left: 0, top: 600, right: 1400, bottom: 900 }, 'bottom', 1400, 900, false)).toEqual({ left: -UNBOUNDED, top: -UNBOUNDED, right: UNBOUNDED, bottom: 592 });
    // Fullscreen split: exactly the rest of the screen.
    expect(areaBeside({ left: 0, top: 0, right: 420, bottom: 900 }, 'left', 1400, 900, true)).toEqual({ left: 420, top: 0, right: 1400, bottom: 900 });
  });

  it('réglages : bord, hauteur de la bande et partage du plein écran, bornés', () => {
    expect(normalizeSettings({})).toMatchObject({ dockSide: 'right', stripHeight: 300, splitRatio: 0.7 });
    expect(normalizeSettings({ dockSide: 'left', stripHeight: 5000, splitRatio: 0.1 })).toMatchObject({ dockSide: 'left', stripHeight: 720, splitRatio: 0.4 });
    expect(normalizeSettings({ dockSide: 'diagonal' }).dockSide).toBe('right');
  });
});

describe('côte à côte (fenêtres)', () => {
  const area = { left: 0, top: 25, width: 1920, height: 1055 };

  it('quatre répartitions : 2/3–1/3, 1/2–1/2, notes à gauche, 3/4–1/4', () => {
    expect(TILES.map((t) => t.id)).toEqual(['2/3', '1/2', 'left', '3/4']);
    expect(tileChoice('3/4')).toMatchObject({ notes: 0.25, side: 'right' });
    expect(tileChoice('nope')).toBeNull();
  });

  it('les deux zones couvrent la zone de travail, sans se chevaucher', () => {
    const { video, notes } = tileBounds(area, 1 / 3, 'right');
    expect(video).toEqual({ left: 0, top: 25, width: 1280, height: 1055 });
    expect(notes).toEqual({ left: 1280, top: 25, width: 640, height: 1055 });
    const left = tileBounds(area, 1 / 3, 'left');
    expect(left.notes).toEqual({ left: 0, top: 25, width: 640, height: 1055 });
    expect(left.video).toEqual({ left: 640, top: 25, width: 1280, height: 1055 });
    expect(notesShare(area, notes)).toBe(0.333);
  });

  it('chaque fenêtre garde une largeur utile', () => {
    // 3/4 – 1/4 on a small screen: the notes keep their minimum.
    const small = { left: 0, top: 0, width: 1280, height: 800 };
    expect(tileBounds(small, 0.25, 'right').notes.width).toBe(340);
    // Too small for both: the border stays between 35 % and 65 % of the screen, and can still be dragged there.
    const tiny = { left: 0, top: 0, width: 800, height: 600 };
    expect(tileBounds(tiny, 1 / 3, 'right').video.width).toBe(520);
    expect(followBorder(tiny, 'right', 'video', { left: 0, top: 0, width: 420, height: 600 }).notes).toEqual({ left: 420, top: 0, width: 380, height: 600 });
    expect(followBorder(tiny, 'right', 'video', { left: 0, top: 0, width: 100, height: 600 }).video.width).toBe(280);
  });

  it('une fenêtre redimensionnée par son bord intérieur : l’autre suit la frontière', () => {
    // The video window narrowed to 1000 px: the notes start there and fill the rest.
    expect(followBorder(area, 'right', 'video', { left: 0, top: 25, width: 1000, height: 1055 })).toEqual({
      video: { left: 0, top: 25, width: 1000, height: 1055 },
      notes: { left: 1000, top: 25, width: 920, height: 1055 },
    });
    // Notes on the left, widened to 800 px: the video starts after them.
    expect(followBorder(area, 'left', 'notes', { left: 0, top: 25, width: 800, height: 1055 }).video).toEqual({ left: 800, top: 25, width: 1120, height: 1055 });
    expect(sameBounds({ left: 0, top: 0, width: 100, height: 100 }, { left: 2, top: 1, width: 103, height: 100 })).toBe(true);
    expect(sameBounds({ left: 0, top: 0, width: 100, height: 100 }, { left: 0, top: 0, width: 110, height: 100 })).toBe(false);
  });

  it('fin du côte à côte : la fenêtre revient à sa taille, ramenée sur l’écran si besoin', () => {
    expect(within({ left: 10, top: 10, width: 1400, height: 1040 }, { left: 0, top: 0, width: 800, height: 600 })).toEqual({ left: 0, top: 0, width: 800, height: 600 });
    expect(within({ left: 100, top: 50, width: 600, height: 400 }, area)).toEqual({ left: 100, top: 50, width: 600, height: 400 });
  });
});
