import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Tiler } from '../../src/background/tiling';
import { judgeChange, type Bounds } from '../../src/shared/tiling';
import { MemoryArea } from './helpers';

/**
 * « Côte à côte » never makes the windows shake: a simulated window manager
 * (Chrome's minimum browser width, the system's snap of side-by-side windows
 * with its invisible borders, a window dragged aside) against the tiler.
 */

const VIDEO = 1;
const NOTES = 2;
const AREA: Bounds = { left: 0, top: 0, width: 1920, height: 1080 };

type Win = Bounds & { id: number; state: 'normal' | 'maximized' | 'minimized' | 'fullscreen' };

class FakeWindows {
  readonly wins = new Map<number, Win>();
  /** Every move Boo Notes asked for. */
  readonly byTiler: Array<{ at: number; id: number }> = [];
  /** Moves made by the simulated system. */
  readonly bySystem: Array<{ at: number; id: number }> = [];
  listener: ((w: chrome.windows.Window) => void) | null = null;
  /** Narrowest browser window the platform allows (≈ 508 px; more with a large display scale). */
  minVideo = 508;

  constructor(private readonly clock: () => number) {
    this.wins.set(VIDEO, { id: VIDEO, left: 60, top: 60, width: 1400, height: 900, state: 'normal' });
  }

  /** Chrome keeps a browser window at least `minVideo` px wide; the change is reported a moment later. */
  apply(id: number, b: Partial<Win>, by: 'tiler' | 'system'): Win {
    const w = this.wins.get(id)!;
    const next: Win = { ...w, ...b };
    if (id === VIDEO) next.width = Math.max(this.minVideo, next.width);
    this.wins.set(id, next);
    (by === 'tiler' ? this.byTiler : this.bySystem).push({ at: this.clock(), id });
    setTimeout(() => this.listener?.({ ...next } as unknown as chrome.windows.Window), 5);
    return next;
  }

  chrome() {
    return {
      windows: {
        get: async (id: number) => ({ ...this.wins.get(id)! }),
        update: async (id: number, info: Partial<Win>) => ({ ...this.apply(id, info, 'tiler') }),
      },
      tabs: { get: async () => ({ id: 7, windowId: VIDEO }) },
      storage: { session: new MemoryArea() },
    };
  }
}

let fake: FakeWindows;
let tiler: Tiler;

beforeEach(() => {
  vi.useFakeTimers();
  fake = new FakeWindows(() => Date.now());
  vi.stubGlobal('chrome', fake.chrome());
  tiler = new Tiler({
    openNotes: async (_tab, bounds) => {
      fake.wins.set(NOTES, { id: NOTES, ...bounds, state: 'normal' });
      fake.apply(NOTES, bounds, 'tiler');
      return NOTES;
    },
  });
  fake.listener = (w) => void tiler.onBoundsChanged(w);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const status = () => tiler.status(7);
const after = (since: number) => fake.byTiler.filter((m) => m.at >= since).length;

describe('côte à côte stable', () => {
  it('ce que le système corrige après une mise en place n’est jamais « suivi » (taille minimale de Chrome)', async () => {
    // 1/2 on a 1000 px screen, with a display scale where Chrome keeps its window at least 600 px wide.
    fake.minVideo = 600;
    await tiler.set(7, '1/2', { left: 0, top: 0, width: 1000, height: 700 });
    await vi.advanceTimersByTimeAsync(3000);
    const v = fake.wins.get(VIDEO)!;
    const n = fake.wins.get(NOTES)!;
    // The notes start where the video really ends: no overlap, no gap, and nothing moved again.
    expect(v.width).toBe(600);
    expect(n.left).toBe(v.left + v.width);
    expect(n.left + n.width).toBe(1000);
    expect(fake.byTiler.length).toBe(2);
    expect(await status()).toBe('1/2');
  });

  it('la frontière tirée : l’autre fenêtre suit, une seule fois', async () => {
    await tiler.set(7, '2/3', AREA);
    await vi.advanceTimersByTimeAsync(2000);
    const t0 = Date.now();
    // The user drags the notes' left edge 200 px to the left.
    fake.apply(NOTES, { left: 1080, width: 840 }, 'system');
    await vi.advanceTimersByTimeAsync(3000);
    expect(after(t0)).toBe(1);
    expect(fake.wins.get(VIDEO)).toMatchObject({ left: 0, width: 1080 });
    expect(await status()).toBe('2/3');
  });

  /** The system's snap group (Windows-like): every 120 ms, the snapped windows' visible edges are made to touch (rects overlap by 2 × 7 px). */
  const snapGroup = (fix: 'video' | 'notes') =>
    setInterval(() => {
      const v = fake.wins.get(VIDEO)!;
      const n = fake.wins.get(NOTES)!;
      if (fix === 'video' && Math.abs(v.left + v.width - (n.left + 14)) > 1) fake.apply(VIDEO, { width: n.left + 14 - v.left }, 'system');
      if (fix === 'notes' && Math.abs(n.left - (v.left + v.width - 14)) > 1) fake.apply(NOTES, { left: v.left + v.width - 14, width: n.left + n.width - (v.left + v.width - 14) }, 'system');
    }, 120);

  for (const fix of ['video', 'notes'] as const) {
    it(`le système range aussi les fenêtres (aimantation, bordures invisibles ; il corrige ${fix === 'video' ? 'la vidéo' : 'les notes'}) : plus de ping-pong`, async () => {
      await tiler.set(7, '1/2', AREA);
      await vi.advanceTimersByTimeAsync(2000);
      const agent = snapGroup(fix);
      const t0 = Date.now();
      // The user drags the common border once.
      if (fix === 'video') fake.apply(NOTES, { left: 1060, width: 860 }, 'system');
      else fake.apply(VIDEO, { width: 1060 }, 'system');
      await vi.advanceTimersByTimeAsync(10_000);
      clearInterval(agent);
      // Before the fix: the two kept correcting each other, the windows crawling 14 px at a time, forever.
      expect(after(t0)).toBeLessThanOrEqual(TILE_FOLLOW_LIMIT_COUNT);
      const late = [...fake.byTiler, ...fake.bySystem].filter((m) => m.at > t0 + 4000).length;
      expect(late).toBe(0);
    });
  }

  it('une fenêtre déplacée (pour faire de la place à une autre application) : l’autre ne bouge pas, le côte à côte s’arrête', async () => {
    await tiler.set(7, '2/3', AREA);
    await vi.advanceTimersByTimeAsync(2000);
    const notes = { ...fake.wins.get(NOTES)! };
    const t0 = Date.now();
    // A title-bar drag: 20 steps of 20 px.
    for (let i = 1; i <= 20; i++) {
      fake.apply(VIDEO, { left: i * 20 }, 'system');
      await vi.advanceTimersByTimeAsync(40);
    }
    await vi.advanceTimersByTimeAsync(3000);
    expect(after(t0)).toBe(0);
    expect(fake.wins.get(NOTES)).toMatchObject({ left: notes.left, width: notes.width });
    expect(await status()).toBeNull();
    expect(((await chrome.storage.session.get('tile:ended'))['tile:ended'] as { reason: string }).reason).toBe('moved');
  });

  it('agrandie par l’utilisateur : Boo Notes la laisse ; réduite en icône : le côte à côte tient', async () => {
    await tiler.set(7, '2/3', AREA);
    await vi.advanceTimersByTimeAsync(2000);
    fake.apply(VIDEO, { state: 'minimized' }, 'system');
    await vi.advanceTimersByTimeAsync(500);
    fake.apply(VIDEO, { state: 'normal' }, 'system');
    await vi.advanceTimersByTimeAsync(500);
    expect(await status()).toBe('2/3');
    fake.apply(VIDEO, { state: 'maximized', left: 0, top: 0, width: 1920, height: 1080 }, 'system');
    await vi.advanceTimersByTimeAsync(500);
    expect(await status()).toBeNull();
    expect(fake.byTiler.length).toBe(2);
  });
});

const TILE_FOLLOW_LIMIT_COUNT = 6;

describe('lecture d’un changement de fenêtre', () => {
  const video: Bounds = { left: 0, top: 0, width: 1280, height: 1080 };
  const notes: Bounds = { left: 1280, top: 0, width: 640, height: 1080 };
  it('seul le bord intérieur a bougé : la frontière', () => {
    expect(judgeChange('right', 'video', video, { ...video, width: 1100 })).toBe('border');
    expect(judgeChange('right', 'notes', notes, { left: 1100, top: 0, width: 820, height: 1080 })).toBe('border');
    expect(judgeChange('left', 'notes', { left: 0, top: 0, width: 640, height: 1080 }, { left: 0, top: 0, width: 800, height: 1080 })).toBe('border');
  });
  it('déplacée, son bord extérieur ou sa hauteur changés : rangée autrement', () => {
    expect(judgeChange('right', 'video', video, { ...video, left: 200 })).toBe('rearranged');
    expect(judgeChange('right', 'notes', notes, { ...notes, width: 500 })).toBe('rearranged');
    expect(judgeChange('right', 'video', video, { ...video, height: 700 })).toBe('rearranged');
  });
  it('quelques pixels (bordures, arrondis) : la même', () => {
    expect(judgeChange('right', 'video', video, { left: 2, top: 0, width: 1276, height: 1082 })).toBe('same');
  });
});
