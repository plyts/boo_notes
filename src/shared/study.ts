import type { MediaKind } from './platforms';
import { formatTimecode } from './time';

/** Study status shown in the library and mirrored in Notion. */
export type StudyStatus = 'todo' | 'doing' | 'done';

export const STATUS_LABELS: Record<StudyStatus, string> = {
  todo: 'À commencer',
  doing: 'En cours',
  done: 'Terminé',
};

/** What the progress helpers need to know about a course / note. */
export interface StudyShape {
  kind: MediaKind;
  /** Media: seconds. PDF / text: page / paragraph and their count. Web page: percent read (duration 100). */
  progress?: { position: number; duration: number; updatedAt: number };
  /** Furthest point reached (same unit as `progress.position`). */
  furthest?: number;
  /** Manual status. */
  status?: StudyStatus;
  noteCount?: number;
  /** Length of the note (characters). */
  size?: number;
  review?: { count: number };
  pins?: unknown[];
}

/** 0..1: how much of the course has been covered (furthest point reached). */
export function progressRatio(item: StudyShape): number {
  const p = item.progress;
  if (!p || !(p.duration > 0)) return 0;
  const reached = Math.max(p.position, item.furthest ?? 0);
  return Math.min(1, Math.max(0, reached / p.duration));
}

export function studyStatus(item: StudyShape): StudyStatus {
  if (item.status) return item.status;
  if (item.kind === 'note' || item.kind === 'image') {
    // Revision sheets and images: "done" once reviewed successfully three times in a row.
    if (item.review && item.review.count >= 3) return 'done';
    return (item.size ?? 0) > 0 || (item.noteCount ?? 0) > 0 ? 'doing' : 'todo';
  }
  const ratio = progressRatio(item);
  if (item.kind === 'pdf' || item.kind === 'text' ? ratio >= 1 : ratio >= 0.95) return 'done';
  if (ratio > 0 || (item.noteCount ?? 0) > 0) return 'doing';
  return 'todo';
}

/** `12:34 / 45:00`, `p. 12 / 240`, `§ 4 / 30`, `62 % lu`, `3 repères`. */
export function positionLabel(item: StudyShape): string {
  if (item.kind === 'image') {
    const n = item.pins?.length ?? 0;
    return n ? `${n} repère${n > 1 ? 's' : ''}` : '';
  }
  const p = item.progress;
  if (!p) return '';
  const total = p.duration ? ` / ${p.duration}` : '';
  switch (item.kind) {
    case 'pdf':
      return `p. ${Math.max(1, Math.round(p.position))}${total}`;
    case 'text':
      return `§ ${Math.max(1, Math.round(p.position))}${total}`;
    case 'page':
      return `${Math.round(progressRatio(item) * 100)} % lu`;
    case 'note':
      return '';
    default:
      return p.duration ? `${formatTimecode(p.position)} / ${formatTimecode(p.duration)}` : formatTimecode(p.position);
  }
}

// --- Spaced repetition of revision sheets -----------------------------------------------------

/** Intervals (days) of the review ladder. */
export const REVIEW_STEPS = [1, 3, 7, 14, 30, 60, 120];

export type ReviewGrade = 'again' | 'good' | 'easy';

/** Next interval (days) after a review graded `grade`, from the current interval. */
export function nextInterval(current: number | undefined, grade: ReviewGrade): number {
  if (grade === 'again') return REVIEW_STEPS[0];
  const step = current ? REVIEW_STEPS.indexOf(current) : -1;
  return REVIEW_STEPS[Math.min(REVIEW_STEPS.length - 1, step + (grade === 'easy' ? 2 : 1))];
}
