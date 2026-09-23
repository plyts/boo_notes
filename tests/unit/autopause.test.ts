import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TypingAutoPause } from '../../src/shared/autopause';

function setup(playing = true) {
  const state = { playing };
  const actions = {
    isPlaying: () => state.playing,
    pause: vi.fn(() => {
      state.playing = false;
    }),
    play: vi.fn(() => {
      state.playing = true;
    }),
  };
  const ap = new TypingAutoPause(actions);
  ap.enabled = true;
  return { ap, actions, state };
}

/** Types one key every `interval` ms for `duration` ms. */
function type(ap: TypingAutoPause, duration: number, interval = 150) {
  for (let t = 0; t <= duration; t += interval) {
    ap.keystroke();
    vi.advanceTimersByTime(interval);
  }
}

describe('TypingAutoPause', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  it('pauses after 1.5 s of continuous typing and resumes 1 s after the last key', () => {
    const { ap, actions } = setup();
    type(ap, 1200);
    expect(actions.pause).not.toHaveBeenCalled();
    type(ap, 600);
    expect(actions.pause).toHaveBeenCalledTimes(1);
    expect(ap.pausedByTyping).toBe(true);
    // `type()` already waited 150 ms after the last key.
    vi.advanceTimersByTime(800);
    expect(actions.play).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(actions.play).toHaveBeenCalledTimes(1);
    expect(ap.pausedByTyping).toBe(false);
  });

  it('treats a pause longer than 1 s as a new burst', () => {
    const { ap, actions } = setup();
    type(ap, 1000);
    vi.advanceTimersByTime(1200);
    type(ap, 1000);
    expect(actions.pause).not.toHaveBeenCalled();
  });

  it('never resumes a video the user paused', () => {
    const { ap, actions } = setup(false);
    type(ap, 3000);
    vi.advanceTimersByTime(2000);
    expect(actions.pause).not.toHaveBeenCalled();
    expect(actions.play).not.toHaveBeenCalled();
  });

  it('does not resume after release() (Smart Pause / manual control)', () => {
    const { ap, actions } = setup();
    type(ap, 2000);
    expect(actions.pause).toHaveBeenCalled();
    ap.release();
    vi.advanceTimersByTime(2000);
    expect(actions.play).not.toHaveBeenCalled();
  });

  it('does nothing when disabled', () => {
    const { ap, actions } = setup();
    ap.enabled = false;
    type(ap, 3000);
    expect(actions.pause).not.toHaveBeenCalled();
  });
});
