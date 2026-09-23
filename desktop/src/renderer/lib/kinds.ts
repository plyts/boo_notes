import type { IconName } from '../../../../src/shared/icons';
import { KIND_LABELS, PLATFORM_LABELS, type MediaKind } from '../../../../src/shared/platforms';
import { STATUS_LABELS } from '../../../../src/shared/study';

export { KIND_LABELS, PLATFORM_LABELS, STATUS_LABELS };

export const KIND_ICON: Record<MediaKind, IconName> = {
  video: 'video',
  audio: 'headphones',
  pdf: 'file',
  text: 'text',
  image: 'image',
  page: 'globe',
  note: 'cards',
};

/** System colour of each kind (badges, graph nodes). */
export const KIND_COLOR: Record<MediaKind, string> = {
  video: 'var(--c-purple)',
  audio: 'var(--c-orange)',
  pdf: 'var(--c-red)',
  text: 'var(--c-yellow)',
  image: 'var(--c-pink)',
  page: 'var(--c-blue)',
  note: 'var(--c-green)',
};

/** Plural labels, for filters and sections. */
export const KIND_PLURALS: Record<MediaKind, string> = {
  video: 'Vidéos',
  audio: 'Audios',
  pdf: 'PDF',
  text: 'Textes',
  image: 'Images',
  page: 'Pages web',
  note: 'Fiches',
};

/** Colour of a course from its hue. */
export function courseColor(hue: number, alpha = 1): string {
  return `hsl(${hue} 72% 58% / ${alpha})`;
}
