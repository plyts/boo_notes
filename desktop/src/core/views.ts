import { positionLabel, progressRatio, studyStatus, type StudyShape } from '../../../src/shared/study';
import { isDue, type Library } from './library';
import type { Course, MediaKind, Note, Platform, Resource, StudyStatus } from './types';

/** A resource as displayed: derived status, progress, and the notes about it. */
export interface ResourceView extends Resource {
  studyStatus: StudyStatus;
  /** 0..1 */
  ratio: number;
  positionLabel: string;
  /** Notes linked to it. */
  notes: string[];
}

/** A note as displayed: its main resource's kind and progress, its filing, its review. */
export interface NoteView extends Note {
  /** Kind of the main resource; `note` for a revision sheet. */
  kind: MediaKind;
  platform: Platform;
  /** Source of the main resource (URL or path), empty for a sheet. */
  source: string;
  studyStatus: StudyStatus;
  ratio: number;
  positionLabel: string;
  /** A review is due today. */
  due: boolean;
  courseId: string | null;
  chapterId: string | null;
}

export interface CourseView extends Course {
  noteCount: number;
  resourceCount: number;
  doneCount: number;
  dueCount: number;
  /** Mean progress of its notes (0..1). */
  ratio: number;
}

export interface LibrarySnapshot {
  notes: NoteView[];
  resources: ResourceView[];
  courses: CourseView[];
  /** Notes filed nowhere, most recent first. */
  inbox: string[];
}

function resourceShape(res: Resource, noteCount?: number): StudyShape {
  return { kind: res.kind, progress: res.progress, furthest: res.furthest, status: res.status, noteCount, pins: res.pins };
}

export function resourceView(lib: Library, res: Resource): ResourceView {
  const notes = lib.notesOf(res.id).map((n) => n.id);
  const shape = resourceShape(res, notes.length ? 1 : 0);
  return { ...res, studyStatus: studyStatus(shape), ratio: progressRatio(shape), positionLabel: positionLabel(shape), notes };
}

export function noteView(lib: Library, note: Note, now = Date.now()): NoteView {
  const primary = note.resources[0] ? lib.getResource(note.resources[0]) : undefined;
  const placement = lib.placement(note.id);
  const shape: StudyShape = primary
    ? resourceShape(primary, note.noteCount)
    : { kind: 'note', review: note.review, size: note.size, noteCount: note.noteCount };
  const derived = studyStatus(shape);
  return {
    ...note,
    kind: primary?.kind ?? 'note',
    platform: primary?.platform ?? 'local',
    source: primary?.source ?? '',
    studyStatus: note.status ?? derived,
    ratio: note.status === 'done' ? 1 : progressRatio(shape),
    positionLabel: positionLabel(shape),
    due: isDue(note, now),
    courseId: placement?.courseId ?? null,
    chapterId: placement?.chapterId ?? null,
  };
}

export function courseView(course: Course, views: Map<string, NoteView>): CourseView {
  const noteIds = course.chapters.flatMap((c) => c.notes).filter((id) => views.has(id));
  const notes = noteIds.map((id) => views.get(id)!);
  const resources = new Set(notes.flatMap((n) => n.resources));
  const done = notes.filter((n) => n.studyStatus === 'done').length;
  const ratio = notes.length ? notes.reduce((sum, n) => sum + (n.studyStatus === 'done' ? 1 : n.ratio), 0) / notes.length : 0;
  return {
    ...course,
    chapters: course.chapters.map((c) => ({ ...c, notes: c.notes.filter((id) => views.has(id)) })),
    noteCount: notes.length,
    resourceCount: resources.size,
    doneCount: done,
    dueCount: notes.filter((n) => n.due).length,
    ratio,
  };
}

/** Everything the UI shows, in one plain-data object. */
export function snapshot(lib: Library, now = Date.now()): LibrarySnapshot {
  const notes = lib.listNotes().map((n) => noteView(lib, n, now));
  const byId = new Map(notes.map((n) => [n.id, n]));
  return {
    notes,
    resources: lib.listResources().map((r) => resourceView(lib, r)),
    courses: lib.listCourses().map((c) => courseView(c, byId)),
    inbox: notes.filter((n) => !n.courseId).map((n) => n.id),
  };
}

/** Course and chapter titles of a note (Notion columns, exports). */
export function filing(lib: Library, noteId: string): { course: Course; chapter: Course['chapters'][number] } | null {
  const p = lib.placement(noteId);
  const course = p ? lib.getCourse(p.courseId) : undefined;
  const chapter = course?.chapters.find((c) => c.id === p?.chapterId);
  return course && chapter ? { course, chapter } : null;
}
