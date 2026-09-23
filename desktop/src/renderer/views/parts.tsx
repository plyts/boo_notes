import type { ReactNode } from 'react';
import { GridList, GridListItem, useDragAndDrop, type DragAndDropHooks } from 'react-aria-components';
import type { NoteView, ResourceView } from '../../ipc';
import { dueLabel, relativeTime } from '../lib/format';
import { courseColor, KIND_COLOR, KIND_ICON, KIND_LABELS, STATUS_LABELS } from '../lib/kinds';
import { NOTE_DRAG } from '../shell/Sidebar';
import { useApp } from '../store';
import { Icon, Ring } from '../ui';

export function KindBadge({ kind, size = 30 }: { kind: NoteView['kind']; size?: number }) {
  return (
    <span className="kind-badge" style={{ ['--kind' as string]: KIND_COLOR[kind], width: size, height: size }} aria-hidden="true">
      <Icon name={KIND_ICON[kind]} size={Math.round(size * 0.55)} />
    </span>
  );
}

export function StatusChip({ note }: { note: NoteView }) {
  if (note.due) return <span className="chip chip-warn">À réviser</span>;
  return <span className={`chip chip-status-${note.studyStatus}`}>{STATUS_LABELS[note.studyStatus]}</span>;
}

/** One line of a list of notes. */
export function NoteRowContent({ note, showPlace = true }: { note: NoteView; showPlace?: boolean }) {
  const courses = useApp((s) => s.courses);
  const resources = useApp((s) => s.resources);
  const course = note.courseId ? courses.get(note.courseId) : undefined;
  const chapter = course?.chapters.find((c) => c.id === note.chapterId);
  const kinds = note.resources.slice(1).flatMap((id) => (resources.get(id) ? [resources.get(id)!.kind] : []));
  const meta = [
    showPlace && course ? `${course.emoji} ${course.title}${chapter ? ` › ${chapter.title}` : ''}` : '',
    note.kind === 'note' && !note.resources.length ? 'Fiche' : KIND_LABELS[note.kind],
    note.noteCount ? `${note.noteCount} ancre${note.noteCount > 1 ? 's' : ''}` : '',
    note.links?.length ? `${note.links.length} lien${note.links.length > 1 ? 's' : ''}` : '',
    note.review && !note.due ? `révision ${dueLabel(note.review.next)}` : '',
  ].filter(Boolean);
  return (
    <>
      <KindBadge kind={note.kind} />
      <span className="row-text">
        <span className="row-title">{note.title}</span>
        <span className="row-meta">
          {meta.join(' · ')}
          {kinds.length ? (
            <span className="row-extra" title={`${kinds.length} autre${kinds.length > 1 ? 's' : ''} support${kinds.length > 1 ? 's' : ''}`}>
              {kinds.slice(0, 4).map((k, i) => (
                <Icon key={i} name={KIND_ICON[k]} size={12} />
              ))}
            </span>
          ) : null}
        </span>
      </span>
      {note.resources.length ? (
        <span className="row-progress">
          <Ring value={note.ratio} size={22} stroke={3} color={course ? courseColor(course.hue) : undefined} />
          <span className="row-pos">{note.positionLabel}</span>
        </span>
      ) : null}
      <StatusChip note={note} />
      <span className="row-date">{relativeTime(note.updatedAt)}</span>
    </>
  );
}

/**
 * Accessible list of notes (arrow keys, Enter opens). Notes can be dragged to
 * a course or chapter of the sidebar; `dnd` adds reordering (course view).
 */
export function NoteList({
  notes,
  label,
  empty,
  showPlace = true,
  dnd,
}: {
  notes: NoteView[];
  label: string;
  empty?: ReactNode;
  showPlace?: boolean;
  dnd?: DragAndDropHooks<NoteView>;
}) {
  const go = useApp((s) => s.go);
  const { dragAndDropHooks } = useDragAndDrop<NoteView>({
    getItems: (keys) => [...keys].map((k) => ({ [NOTE_DRAG]: String(k), 'text/plain': notes.find((n) => n.id === k)?.title ?? '' })),
  });
  return (
    <GridList
      aria-label={label}
      className="rows"
      items={notes}
      selectionMode="none"
      dragAndDropHooks={dnd ?? dragAndDropHooks}
      onAction={(key) => go({ name: 'note', id: String(key) })}
      renderEmptyState={() => (empty ? <div className="rows-empty">{empty}</div> : null)}
    >
      {(note) => (
        <GridListItem id={note.id} textValue={note.title} className="row">
          <NoteRowContent note={note} showPlace={showPlace} />
        </GridListItem>
      )}
    </GridList>
  );
}

/** A resource as a card (grid). */
export function ResourceCardContent({ res }: { res: ResourceView }) {
  return (
    <>
      <span className="res-card-art" style={{ ['--kind' as string]: KIND_COLOR[res.kind] }}>
        {res.kind === 'image' && res.origin !== 'extension' ? (
          <img src={`boo://app/__media/${encodeURIComponent(res.id)}`} alt="" loading="lazy" />
        ) : (
          <Icon name={KIND_ICON[res.kind]} size={28} />
        )}
      </span>
      <span className="res-card-title">{res.title}</span>
      <span className="res-card-meta">
        {[KIND_LABELS[res.kind], res.positionLabel, res.notes.length ? `${res.notes.length} note${res.notes.length > 1 ? 's' : ''}` : 'aucune note']
          .filter(Boolean)
          .join(' · ')}
      </span>
      {res.ratio > 0 ? (
        <span className="res-card-bar">
          <span style={{ width: `${Math.round(res.ratio * 100)}%` }} />
        </span>
      ) : null}
    </>
  );
}
