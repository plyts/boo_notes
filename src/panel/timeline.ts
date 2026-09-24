import { h } from '../shared/icons';
import { formatTimecode } from '../shared/time';
import type { NoteMarker } from './editor';

export interface TimelineHooks {
  seek(seconds: number): void;
  /** Hovering the timeline previews the position on the video's own progress bar. */
  preview(seconds: number | null): void;
}

const SNAP_PX = 5;

/**
 * Mini seek bar in the panel footer: video progress plus one tick per note
 * timestamp / capture. It makes the "shape" of the notes visible at a glance
 * and lets the user jump anywhere (click, or arrow keys when focused).
 */
export class Timeline {
  readonly el: HTMLDivElement;
  private readonly progress: HTMLDivElement;
  private readonly playhead: HTMLDivElement;
  private readonly ticks: HTMLDivElement;
  private readonly tip: HTMLDivElement;
  private markers: NoteMarker[] = [];
  private readonly coverage: HTMLDivElement;
  private readonly pending: HTMLDivElement;
  private coverageRanges: Array<[number, number]> = [];
  private pendingRange: { start: number; end?: number } | null = null;
  private duration = 0;
  private time = 0;
  private renderedFor = '';

  constructor(private readonly hooks: TimelineHooks) {
    this.progress = h('div', { class: 'tl-progress' });
    this.playhead = h('div', { class: 'tl-playhead' });
    this.ticks = h('div', { class: 'tl-ticks', 'aria-hidden': 'true' });
    this.tip = h('div', { class: 'tl-tip', 'aria-hidden': 'true' });
    // Sound of the course kept (thin bar under the track), passage being made (band from its start).
    this.coverage = h('div', { class: 'tl-coverage', 'aria-hidden': 'true' });
    this.pending = h('div', { class: 'tl-pending', 'aria-hidden': 'true', hidden: true });
    this.el = h(
      'div',
      {
        class: 'timeline',
        role: 'slider',
        tabindex: '0',
        'aria-label': 'Chronologie de la vidéo et de vos notes',
        'aria-valuemin': '0',
      },
      h('div', { class: 'tl-track' }, this.progress),
      this.coverage,
      this.pending,
      this.ticks,
      this.playhead,
      this.tip,
    );
    this.el.hidden = true;
    this.bind();
  }

  setMarkers(markers: NoteMarker[]): void {
    this.markers = markers;
    this.renderTicks();
  }

  /** Stretches whose sound is kept (seconds). */
  setCoverage(ranges: Array<[number, number]>): void {
    this.coverageRanges = ranges;
    this.renderOverlays();
  }

  /** Passage started (and not yet ended), or being recorded afterwards. */
  setPending(range: { start: number; end?: number } | null): void {
    this.pendingRange = range;
    this.renderOverlays();
  }

  private renderOverlays(): void {
    const d = this.duration;
    if (!(d > 0)) return;
    const pct = (s: number) => `${Math.min(100, Math.max(0, (s / d) * 100))}%`;
    this.coverage.replaceChildren(
      ...this.coverageRanges.map(([a, b]) => {
        const seg = h('span', {});
        seg.style.left = pct(a);
        seg.style.width = `${Math.max(0.4, ((Math.min(b, d) - a) / d) * 100)}%`;
        return seg;
      }),
    );
    const p = this.pendingRange;
    this.pending.hidden = !p;
    if (p) {
      this.pending.style.left = pct(p.start);
      this.pending.style.width = `${Math.max(0, (((p.end ?? this.time) - p.start) / d) * 100)}%`;
    }
  }

  update(time: number | null, duration: number): void {
    const visible = time !== null && duration > 0;
    this.el.hidden = !visible;
    if (!visible) return;
    this.time = time;
    if (duration !== this.duration) {
      this.duration = duration;
      this.el.setAttribute('aria-valuemax', String(Math.round(duration)));
      this.renderTicks();
      this.renderOverlays();
    }
    if (this.pendingRange && this.pendingRange.end === undefined) this.renderOverlays();
    const pct = `${Math.min(100, (time / duration) * 100)}%`;
    this.progress.style.width = pct;
    this.playhead.style.left = pct;
    this.el.setAttribute('aria-valuenow', String(Math.round(time)));
    this.el.setAttribute('aria-valuetext', `${formatTimecode(time)} sur ${formatTimecode(duration)}`);
  }

  private renderTicks(): void {
    if (!(this.duration > 0)) return;
    const key = `${this.duration}|${this.markers.map((m) => `${m.kind[0]}${m.seconds}-${m.end ?? ''}`).join(',')}`;
    if (key === this.renderedFor) return;
    this.renderedFor = key;
    this.ticks.replaceChildren(
      ...this.markers
        .filter((m) => m.seconds <= this.duration)
        .map((m) => {
          const tick = h('span', { class: 'tl-tick', 'data-kind': m.kind, 'data-t': String(m.seconds) });
          tick.style.left = `${(m.seconds / this.duration) * 100}%`;
          // A passage is a band from its start to its end.
          if (m.end !== undefined) tick.style.width = `${((Math.min(m.end, this.duration) - m.seconds) / this.duration) * 100}%`;
          return tick;
        }),
    );
  }

  /** Seconds under the pointer, snapped to a nearby note tick. */
  private secondsAt(clientX: number): { seconds: number; snapped: NoteMarker | null } {
    const r = this.el.getBoundingClientRect();
    const x = Math.min(r.width, Math.max(0, clientX - r.left));
    let snapped: NoteMarker | null = null;
    for (const m of this.markers) {
      const mx = (m.seconds / this.duration) * r.width;
      if (Math.abs(mx - x) <= SNAP_PX && (!snapped || Math.abs(mx - x) < Math.abs((snapped.seconds / this.duration) * r.width - x))) {
        snapped = m;
      }
    }
    return { seconds: snapped ? snapped.seconds : (x / r.width) * this.duration, snapped };
  }

  private bind(): void {
    let lastPreview = 0;
    this.el.addEventListener('pointermove', (e) => {
      if (!(this.duration > 0)) return;
      const { seconds, snapped } = this.secondsAt(e.clientX);
      const r = this.el.getBoundingClientRect();
      this.tip.textContent = snapped
        ? snapped.kind === 'passage' && snapped.end !== undefined
          ? `passage ${formatTimecode(snapped.seconds)}–${formatTimecode(snapped.end)}`
          : `${formatTimecode(seconds)} · ${snapped.kind === 'capture' ? 'capture' : 'note'}`
        : formatTimecode(seconds);
      this.tip.style.left = `${Math.min(r.width - 8, Math.max(8, ((seconds / this.duration) * r.width)))}px`;
      this.el.classList.add('hover');
      const now = performance.now();
      if (now - lastPreview > 60) {
        lastPreview = now;
        this.hooks.preview(seconds);
      }
    });
    this.el.addEventListener('pointerleave', () => {
      this.el.classList.remove('hover');
      this.hooks.preview(null);
    });
    this.el.addEventListener('click', (e) => {
      if (this.duration > 0) this.hooks.seek(this.secondsAt(e.clientX).seconds);
    });
    this.el.addEventListener('keydown', (e) => {
      if (!(this.duration > 0)) return;
      const steps: Record<string, number> = { ArrowLeft: -5, ArrowRight: 5, PageDown: -30, PageUp: 30 };
      let target: number | null = null;
      if (e.key in steps) target = this.time + steps[e.key];
      else if (e.key === 'Home') target = 0;
      else if (e.key === 'End') target = this.duration - 1;
      if (target === null || e.altKey || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      this.hooks.seek(Math.min(this.duration, Math.max(0, target)));
    });
  }
}
