/**
 * Optional "auto-pause while typing" micro-interaction:
 * the video pauses after `pauseAfterMs` of continuous typing and resumes
 * `resumeAfterMs` after the last keystroke — but only if we paused it.
 */
export interface PlaybackActions {
  isPlaying(): boolean;
  pause(): void;
  play(): void;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export class TypingAutoPause {
  enabled = false;
  private burstStart: number | null = null;
  private lastKey = Number.NEGATIVE_INFINITY;
  private autoPaused = false;
  private resumeTimer: unknown = null;

  constructor(
    private readonly actions: PlaybackActions,
    private readonly opts = { pauseAfterMs: 1500, resumeAfterMs: 1000 },
    private readonly clock: Clock = systemClock,
  ) {}

  get pausedByTyping(): boolean {
    return this.autoPaused;
  }

  keystroke(): void {
    if (!this.enabled) return;
    const now = this.clock.now();
    // A gap longer than the resume delay ends the burst.
    if (this.burstStart === null || now - this.lastKey > this.opts.resumeAfterMs) this.burstStart = now;
    this.lastKey = now;
    if (!this.autoPaused && now - this.burstStart >= this.opts.pauseAfterMs && this.actions.isPlaying()) {
      this.autoPaused = true;
      this.actions.pause();
    }
    if (this.resumeTimer !== null) this.clock.clearTimeout(this.resumeTimer);
    this.resumeTimer = this.clock.setTimeout(() => this.onIdle(), this.opts.resumeAfterMs);
  }

  /** The user took over playback (manual play / pause, Smart Pause…): never auto-resume. */
  release(): void {
    this.autoPaused = false;
  }

  dispose(): void {
    if (this.resumeTimer !== null) this.clock.clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    this.burstStart = null;
    this.autoPaused = false;
  }

  private onIdle(): void {
    this.resumeTimer = null;
    this.burstStart = null;
    if (!this.autoPaused) return;
    this.autoPaused = false;
    this.actions.play();
  }
}
