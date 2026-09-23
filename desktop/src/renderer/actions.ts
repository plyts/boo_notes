import type { Placement } from '../ipc';
import { errorMessage } from './lib/format';
import { useApp } from './store';
import { confirm, prompt, toast } from './ui';

/** Where a new note goes: the chapter being viewed, else the note's own chapter, else nowhere. */
export function currentPlacement(): Placement | undefined {
  const { route, courses, notes } = useApp.getState();
  if (route.name === 'course') {
    const course = courses.get(route.id);
    if (course) return { courseId: course.id, chapterId: course.chapters.at(-1)!.id };
  }
  if (route.name === 'note') {
    const note = notes.get(route.id);
    if (note?.courseId && note.chapterId) return { courseId: note.courseId, chapterId: note.chapterId };
  }
  return undefined;
}

export async function newNote(placement: Placement | undefined = currentPlacement(), title?: string): Promise<void> {
  const name =
    title ??
    (await prompt({
      title: 'Nouvelle note',
      text: 'Une note libre (fiche de révision), à laquelle vous pourrez lier des vidéos, audios, PDF ou images.',
      placeholder: 'Ex. Les lois de Newton',
      confirm: 'Créer',
    }));
  if (!name) return;
  try {
    const note = await window.boo.library.createNote({ title: name, placement });
    await useApp.getState().refresh();
    useApp.getState().go({ name: 'note', id: note.id });
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

export async function newCourse(): Promise<void> {
  const title = await prompt({
    title: 'Nouveau cours',
    text: 'Un cours se découpe en chapitres ; chaque chapitre rassemble vos notes.',
    placeholder: 'Ex. Physique — Électricité',
    confirm: 'Créer le cours',
  });
  if (!title) return;
  try {
    const course = await window.boo.library.createCourse({ title });
    await useApp.getState().refresh();
    const s = useApp.getState();
    s.setExpanded([...new Set([...s.expanded, course.id])]);
    s.go({ name: 'course', id: course.id });
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

export async function newChapter(courseId: string): Promise<void> {
  const title = await prompt({ title: 'Nouveau chapitre', placeholder: 'Ex. Chapitre 2 — La loi d’Ohm', confirm: 'Ajouter' });
  if (!title) return;
  try {
    await window.boo.library.addChapter(courseId, title);
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

/** Opens the note a `[[Titre]]` points to, creating the revision sheet if needed. */
export async function openTitle(title: string): Promise<void> {
  try {
    const note = await window.boo.library.ensureNote(title);
    await useApp.getState().refresh();
    useApp.getState().go({ name: 'note', id: note.id });
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

export async function removeNote(id: string): Promise<void> {
  const note = useApp.getState().notes.get(id);
  if (!note) return;
  const res = await confirm({
    title: `Supprimer « ${note.title} » ?`,
    text:
      note.origin === 'extension'
        ? 'La note reste dans l’extension du navigateur et reviendra à sa prochaine modification. Ses supports restent dans la bibliothèque.'
        : 'Ses supports (fichiers, vidéos…) restent dans la bibliothèque.',
    confirm: 'Supprimer',
    danger: true,
    checkbox: 'Supprimer aussi le fichier de notes (.md)',
  });
  if (!res.ok) return;
  await window.boo.library.removeNote(id, res.checked);
  const s = useApp.getState();
  if (s.route.name === 'note' && s.route.id === id) s.goBack();
}

export async function syncNotion(id: string): Promise<void> {
  try {
    await window.boo.notion.syncItem(id);
    toast('Note synchronisée avec Notion', 'success');
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}
