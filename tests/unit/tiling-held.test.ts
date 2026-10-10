import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Tiler } from '../../src/background/tiling';
import type { Bounds } from '../../src/shared/tiling';
import { MemoryArea } from './helpers';

/**
 * The user's clip (Windows 11, « Côte à côte » 2/3): the video window was
 * snapped to the left half by Windows. Boo Notes made it 2/3 wide; Windows
 * kept it at 1/2, Chrome took 2/3 again… and the notes' window followed every
 * flip, 1/2 ↔ 2/3, about 15 times in 3 s. Black-box agents of that system.
 */

const VIDEO = 1;
const NOTES = 2;
const AREA: Bounds = { left: 0, top: 0, width: 3072, height: 1794 };
const HALF = AREA.width / 2;
const TWO_THIRDS = Math.round((AREA.width * 2) / 3);

type Win = Bounds & { id: number; state: 'normal' };

let wins: Map<number, Win>;
let byTiler: Array<{ at: number; id: number; b: Partial<Bounds> }>;
let listener: (w: chrome.windows.Window) => void;
/** The system keeps the video window snapped at the left half: a resize by Boo Notes is undone a moment later. */
let held = false;

function apply(id: number, b: Partial<Bounds>, by: 'tiler' | 'system'): Win {
  const next = { ...wins.get(id)!, ...b };
  wins.set(id, next);
  if (by === 'tiler') byTiler.push({ at: Date.now(), id, b });
  setTimeout(() => listener({ ...next } as unknown as chrome.windows.Window), 5);
  if (by === 'tiler' && id === VIDEO && held && next.width !== HALF) setTimeout(() => apply(VIDEO, { left: 0, width: HALF }, 'system'), 40);
  return next;
}

let tiler: Tiler;

beforeEach(() => {
  vi.useFakeTimers();
  held = false;
  byTiler = [];
  wins = new Map([[VIDEO, { id: VIDEO, left: 0, top: 0, width: HALF, height: AREA.height, state: 'normal' }]]);
  vi.stubGlobal('chrome', {
    windows: {
      get: async (id: number) => ({ ...wins.get(id)! }),
      update: async (id: number, info: Partial<Bounds>) => ({ ...apply(id, info, 'tiler') }),
    },
    tabs: { get: async () => ({ id: 7, windowId: VIDEO }) },
    storage: { session: new MemoryArea() },
  });
  tiler = new Tiler({
    openNotes: async (_tab, bounds) => {
      wins.set(NOTES, { id: NOTES, ...bounds, state: 'normal' });
      apply(NOTES, bounds, 'tiler');
      return NOTES;
    },
  });
  listener = (w) => void tiler.onBoundsChanged(w);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const notesMoves = (since: number) => byTiler.filter((m) => m.id === NOTES && m.at >= since).length;
const ended = async () => ((await chrome.storage.session.get('tile:ended'))['tile:ended'] as { reason: string } | undefined)?.reason;

describe('côte à côte : une fenêtre aimantée par le système (Windows)', () => {
  it('la vidéo reste à la moitié : les notes se rangent à côté d’elle, une fois, et plus rien ne bouge', async () => {
    held = true;
    await tiler.set(7, '2/3', AREA);
    await vi.advanceTimersByTimeAsync(5000);
    const v = wins.get(VIDEO)!;
    const n = wins.get(NOTES)!;
    // Windows kept the video at 1/2: the notes take the other half — no gap where another window shows through.
    expect(v.width).toBe(HALF);
    expect(n.left).toBe(HALF);
    expect(n.left + n.width).toBe(AREA.width);
    const last = byTiler[byTiler.length - 1].at;
    await vi.advanceTimersByTimeAsync(5000);
    expect(byTiler[byTiler.length - 1].at).toBe(last);
    // Placing the video, the notes, then the notes beside where the video stayed: nothing else.
    expect(byTiler.length).toBeLessThanOrEqual(3);
    expect(((await chrome.storage.session.get('tile:held'))['tile:held'] as { tabId: number }).tabId).toBe(7);
    // The user then drags the notes' inner edge: the held video window is not asked again (no flicker).
    const t0 = Date.now();
    apply(NOTES, { left: 1800, width: AREA.width - 1800 }, 'system');
    await vi.advanceTimersByTimeAsync(3000);
    expect(byTiler.filter((m) => m.at >= t0).length).toBe(0);
    expect(await tiler.status(7)).toBe('2/3');
  });

  it('la fenêtre des notes posée ailleurs par le système : elle revient à côté de la vidéo, une fois, sans dire que la vidéo est tenue', async () => {
    await tiler.set(7, '2/3', AREA);
    // The system put the new notes window its own way (within its settling: taken as it comes).
    apply(NOTES, { left: 2300, width: 772 }, 'system');
    await vi.advanceTimersByTimeAsync(5000);
    expect(wins.get(NOTES)).toMatchObject({ left: TWO_THIRDS, width: AREA.width - TWO_THIRDS });
    expect(byTiler.length).toBe(3);
    expect((await chrome.storage.session.get('tile:held'))['tile:held']).toBeUndefined();
    expect(await tiler.status(7)).toBe('2/3');
  });

  it('la frontière tirée plusieurs fois par l’utilisateur (jamais à un endroit quitté) : l’autre fenêtre suit chaque fois', async () => {
    await tiler.set(7, '2/3', AREA);
    await vi.advanceTimersByTimeAsync(2000);
    const t0 = Date.now();
    // Three drags of the video's edge, a few seconds apart, never back where it was.
    for (const width of [1900, 1700, 2200]) {
      apply(VIDEO, { width }, 'system');
      await vi.advanceTimersByTimeAsync(2500);
    }
    expect(notesMoves(t0)).toBe(3);
    expect(wins.get(NOTES)!.left).toBe(2200);
    expect(await tiler.status(7)).toBe('2/3');
  });

  it('la vidéo passe d’elle-même de 1/2 à 2/3 et retour (la vidéo de l’utilisateur) : les notes ne la suivent plus', async () => {
    await tiler.set(7, '2/3', AREA);
    await vi.advanceTimersByTimeAsync(2000);
    const t0 = Date.now();
    // 3 s of flips, every 200 to 450 ms, as in the clip.
    const steps = [300, 250, 400, 200, 450, 300, 250, 350, 300, 200];
    for (const [i, ms] of steps.entries()) {
      apply(VIDEO, { left: 0, width: i % 2 === 0 ? HALF : TWO_THIRDS }, 'system');
      await vi.advanceTimersByTimeAsync(ms);
    }
    await vi.advanceTimersByTimeAsync(3000);
    // Before: the notes followed each flip (6 moves, then « arrêté »; with the first build, all 10, without end).
    expect(notesMoves(t0)).toBeLessThanOrEqual(1);
    expect(await tiler.status(7)).toBeNull();
    expect(await ended()).toBe('fight');
  });
});
