import {
  Button as AriaButton,
  Dialog,
  DialogTrigger,
  GridList,
  GridListItem,
  isTextDropItem,
  Popover,
  Radio,
  RadioGroup,
  useDragAndDrop,
} from 'react-aria-components';
import type { CourseView as Course, NoteView } from '../../ipc';
import { newChapter, newNote } from '../actions';
import { errorMessage, plural } from '../lib/format';
import { courseColor } from '../lib/kinds';
import { LargeTitle, PageHeader } from '../shell/PageHeader';
import { NOTE_DRAG } from '../shell/Sidebar';
import { useApp, useCourse } from '../store';
import { Button, confirm, Icon, MenuButton, prompt, Ring, toast } from '../ui';
import { EditableTitle } from './EditableTitle';
import { NoteRowContent } from './parts';

const EMOJIS = ['📘', '📗', '📙', '📕', '📓', '🧪', '🧠', '📐', '🎧', '🎬', '⚡', '🧬', '💻', '📊', '🌍', '🎨', '🎹', '⚖️', '🏛️', '🩺', '🧮', '📈', '🔭', '🗣️'];
const HUES = [262, 211, 187, 152, 120, 45, 28, 4, 335, 290];

function Customize({ course }: { course: Course }) {
  const update = (patch: { emoji?: string; hue?: number }) =>
    void window.boo.library.updateCourse(course.id, patch).catch((e: unknown) => toast(errorMessage(e), 'error'));
  return (
    <DialogTrigger>
      <AriaButton className="course-emoji-btn" aria-label="Personnaliser l’icône et la couleur du cours">
        {course.emoji}
      </AriaButton>
      <Popover className="popover glass-thick" placement="bottom start" offset={8}>
        <Dialog className="customize" aria-label="Icône et couleur">
          <RadioGroup aria-label="Icône" className="emoji-grid" value={course.emoji} onChange={(v) => update({ emoji: v })}>
            {EMOJIS.map((e) => (
              <Radio key={e} value={e} className="emoji-choice" aria-label={e}>
                {e}
              </Radio>
            ))}
          </RadioGroup>
          <RadioGroup aria-label="Couleur" orientation="horizontal" className="hue-row" value={String(course.hue)} onChange={(v) => update({ hue: Number(v) })}>
            {HUES.map((h) => (
              <Radio key={h} value={String(h)} className="hue-choice" aria-label={`Teinte ${h}`} style={{ ['--swatch' as string]: courseColor(h) }} />
            ))}
          </RadioGroup>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

function ChapterSection({ course, index }: { course: Course; index: number }) {
  const chapter = course.chapters[index];
  const notesById = useApp((s) => s.notes);
  const go = useApp((s) => s.go);
  const notes = chapter.notes.flatMap((id) => (notesById.get(id) ? [notesById.get(id)!] : []));

  const place = async (ids: string[], at: number) => {
    try {
      for (const [i, id] of ids.entries()) await window.boo.library.placeNote(id, { courseId: course.id, chapterId: chapter.id, index: at + i });
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const indexFor = (ids: string[], key: string, pos: string) => {
    const rest = chapter.notes.filter((id) => !ids.includes(id));
    const i = rest.indexOf(key);
    return i === -1 ? rest.length : pos === 'after' ? i + 1 : i;
  };
  const { dragAndDropHooks } = useDragAndDrop<NoteView>({
    getItems: (keys) => [...keys].map((k) => ({ [NOTE_DRAG]: String(k), 'text/plain': notesById.get(String(k))?.title ?? '' })),
    acceptedDragTypes: [NOTE_DRAG],
    getDropOperation: () => 'move',
    onReorder: (e) => {
      const ids = [...e.keys].map(String);
      void place(ids, indexFor(ids, String(e.target.key), e.target.dropPosition));
    },
    onInsert: async (e) => {
      const ids = await Promise.all(e.items.filter(isTextDropItem).map((i) => i.getText(NOTE_DRAG)));
      await place(ids, indexFor(ids, String(e.target.key), e.target.dropPosition));
    },
    onRootDrop: async (e) => {
      const ids = await Promise.all(e.items.filter(isTextDropItem).map((i) => i.getText(NOTE_DRAG)));
      await place(ids, chapter.notes.length);
    },
    renderDropIndicator: (target) => <div className="drop-indicator" data-target={target.type} />,
  });

  const rename = async () => {
    const title = await prompt({ title: 'Renommer le chapitre', value: chapter.title, confirm: 'Renommer' });
    if (title) await window.boo.library.updateChapter(course.id, chapter.id, { title });
  };
  const remove = async () => {
    const res = await confirm({
      title: `Supprimer « ${chapter.title} » ?`,
      text: notes.length ? `Ses ${plural(notes.length, 'note')} rejoindront le chapitre précédent.` : 'Le chapitre est vide.',
      confirm: 'Supprimer',
      danger: true,
    });
    if (!res.ok) return;
    await window.boo.library.removeChapter(course.id, chapter.id).catch((e: unknown) => toast(errorMessage(e), 'error'));
  };

  return (
    <section className="chapter" aria-labelledby={`chap-${chapter.id}`}>
      <header className="chapter-head">
        <span className="chapter-num" aria-hidden="true">
          {index + 1}
        </span>
        <h2 id={`chap-${chapter.id}`} className="chapter-title">
          {chapter.title}
        </h2>
        <span className="chapter-count">{notes.length ? plural(notes.length, 'note') : ''}</span>
        <span className="toolbar-spacer" />
        <Button size="s" variant="plain" icon="plus" onPress={() => void newNote({ courseId: course.id, chapterId: chapter.id })}>
          Note
        </Button>
        <MenuButton
          label={`Actions du chapitre ${chapter.title}`}
          entries={[
            { id: 'rename', label: 'Renommer…', icon: 'edit', onAction: () => void rename() },
            {
              id: 'up',
              label: 'Monter',
              icon: 'chevronLeft',
              disabled: index === 0,
              onAction: () => void window.boo.library.moveChapter(course.id, chapter.id, index - 1),
            },
            {
              id: 'down',
              label: 'Descendre',
              icon: 'chevronRight',
              disabled: index === course.chapters.length - 1,
              onAction: () => void window.boo.library.moveChapter(course.id, chapter.id, index + 1),
            },
            'separator',
            { id: 'delete', label: 'Supprimer le chapitre…', icon: 'trash', danger: true, disabled: course.chapters.length === 1, onAction: () => void remove() },
          ]}
        />
      </header>
      <GridList
        aria-label={`Notes du chapitre ${chapter.title}`}
        className="rows chapter-rows"
        items={notes}
        dragAndDropHooks={dragAndDropHooks}
        onAction={(key) => go({ name: 'note', id: String(key) })}
        renderEmptyState={() => (
          <div className="chapter-empty">
            Glissez des notes ici, ou <AriaButton className="link-btn" onPress={() => void newNote({ courseId: course.id, chapterId: chapter.id })}>créez-en une</AriaButton>.
          </div>
        )}
      >
        {(note) => (
          <GridListItem id={note.id} textValue={note.title} className="row">
            <AriaButton slot="drag" className="row-grip" aria-label="Déplacer">
              <Icon name="grip" size={14} />
            </AriaButton>
            <NoteRowContent note={note} showPlace={false} />
          </GridListItem>
        )}
      </GridList>
    </section>
  );
}

export function CourseView({ id }: { id: string }) {
  const course = useCourse(id);
  const go = useApp((s) => s.go);
  const setExport = useApp((s) => s.setExport);
  if (!course) {
    return (
      <div className="page">
        <PageHeader />
        <div className="page-content">
          <LargeTitle title="Cours introuvable" subtitle="Il a peut-être été supprimé." />
        </div>
      </div>
    );
  }
  const color = courseColor(course.hue);
  const remove = async () => {
    const res = await confirm({
      title: `Supprimer le cours « ${course.title} » ?`,
      text: 'Ses notes et ses supports sont conservés : ils deviennent « non classés ».',
      confirm: 'Supprimer le cours',
      danger: true,
    });
    if (!res.ok) return;
    await window.boo.library.removeCourse(course.id);
    go({ name: 'today' }, { replace: true });
  };
  return (
    <div className="page" style={{ ['--course' as string]: color }}>
      <PageHeader
        crumbs={[{ label: 'Cours' }, { label: course.title }]}
        actions={
          <>
            <Button variant="glass" icon="mindmap" onPress={() => go({ name: 'graph', courseId: course.id })}>
              Carte mentale
            </Button>
            <Button variant="primary" icon="edit" onPress={() => void newNote({ courseId: course.id, chapterId: course.chapters.at(-1)!.id })}>
              Nouvelle note
            </Button>
            <MenuButton
              label="Actions du cours"
              entries={[
                { id: 'chapter', label: 'Nouveau chapitre…', icon: 'plus', onAction: () => void newChapter(course.id) },
                { id: 'export', label: 'Exporter ce cours…', icon: 'export', onAction: () => setExport(true) },
                'separator',
                { id: 'delete', label: 'Supprimer le cours…', icon: 'trash', danger: true, onAction: () => void remove() },
              ]}
            />
          </>
        }
      />
      <div className="page-content">
        <LargeTitle
          leading={<Customize course={course} />}
          title={
            <EditableTitle
              value={course.title}
              label="Titre du cours"
              onSave={(title) => window.boo.library.updateCourse(course.id, { title })}
            />
          }
          subtitle={`${plural(course.chapters.length, 'chapitre')} · ${plural(course.noteCount, 'note')} · ${plural(course.resourceCount, 'support')}${course.dueCount ? ` · ${course.dueCount} à réviser` : ''}`}
        >
          <div className="course-progress">
            <Ring value={course.ratio} size={52} stroke={6} color={color} />
            <span>
              <strong>{Math.round(course.ratio * 100)} %</strong>
              <small>
                {course.doneCount}/{course.noteCount} terminée{course.doneCount > 1 ? 's' : ''}
              </small>
            </span>
          </div>
        </LargeTitle>
        {course.chapters.map((ch, i) => (
          <ChapterSection key={ch.id} course={course} index={i} />
        ))}
        <AriaButton className="add-chapter" onPress={() => void newChapter(course.id)}>
          <Icon name="plus" size={16} />
          Ajouter un chapitre
        </AriaButton>
      </div>
    </div>
  );
}
