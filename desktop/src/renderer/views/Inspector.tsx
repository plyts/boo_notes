import { Button as AriaButton, Label, ListBox, ListBoxItem, Popover, Select, SelectValue } from 'react-aria-components';
import type { Flashcard } from '../../../../src/shared/cards';
import type { NoteView, StudyStatus } from '../../ipc';
import { openTitle } from '../actions';
import { dueLabel, errorMessage, relativeTime } from '../lib/format';
import { courseColor, KIND_ICON, KIND_LABELS } from '../lib/kinds';
import { backlinksOf, noteByTitle, useApp } from '../store';
import { Button, Icon, MenuButton, toast } from '../ui';

const BADGE_HUES = [262, 28, 187, 335, 120, 45, 211, 4];
const UNFILED = '__none__';

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="insp-section">
      <header className="insp-head">
        <h3>{title}</h3>
        {action}
      </header>
      {children}
    </section>
  );
}

function Picker<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ id: T; label: string }>; onChange(v: T): void }) {
  return (
    <Select className="picker" selectedKey={value} onSelectionChange={(k) => k !== null && onChange(String(k) as T)}>
      <Label className="picker-label">{label}</Label>
      <AriaButton className="picker-button">
        <SelectValue className="picker-value" />
        <Icon name="chevronDown" size={12} />
      </AriaButton>
      <Popover className="popover glass-thick" offset={6}>
        <ListBox className="menu" items={options}>
          {(o) => (
            <ListBoxItem id={o.id} className="menu-item" textValue={o.label}>
              <span className="menu-label">{o.label}</span>
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </Select>
  );
}

export function Inspector({
  note,
  cards,
  activeResource,
  onSelectResource,
  onLink,
}: {
  note: NoteView;
  cards: Flashcard[];
  activeResource: string | null;
  onSelectResource(id: string): void;
  onLink(): void;
}) {
  const snap = useApp((s) => s.snap);
  const resources = useApp((s) => s.resources);
  const notes = useApp((s) => s.notes);
  const status = useApp((s) => s.status);
  const go = useApp((s) => s.go);
  const course = note.courseId ? snap.courses.find((c) => c.id === note.courseId) : undefined;
  const backlinks = backlinksOf(notes.values(), note);
  const run = (p: Promise<unknown>) => void p.catch((e: unknown) => toast(errorMessage(e), 'error'));

  return (
    <div className="inspector-body">
      <Section title="Classement">
        <Picker
          label="Cours"
          value={note.courseId ?? UNFILED}
          options={[{ id: UNFILED, label: 'Non classée' }, ...snap.courses.map((c) => ({ id: c.id, label: `${c.emoji} ${c.title}` }))]}
          onChange={(id) => {
            if (id === UNFILED) run(window.boo.library.placeNote(note.id, null));
            else {
              const c = snap.courses.find((x) => x.id === id);
              if (c) run(window.boo.library.placeNote(note.id, { courseId: c.id, chapterId: c.chapters[0].id }));
            }
          }}
        />
        {course ? (
          <Picker
            label="Chapitre"
            value={note.chapterId ?? course.chapters[0].id}
            options={course.chapters.map((ch, i) => ({ id: ch.id, label: `${i + 1}. ${ch.title}` }))}
            onChange={(id) => run(window.boo.library.placeNote(note.id, { courseId: course.id, chapterId: id }))}
          />
        ) : null}
        <Picker<StudyStatus | 'auto'>
          label="Statut"
          value={note.status ?? 'auto'}
          options={[
            { id: 'auto', label: `Automatique (${note.studyStatus === 'done' ? 'terminé' : note.studyStatus === 'doing' ? 'en cours' : 'à commencer'})` },
            { id: 'todo', label: 'À commencer' },
            { id: 'doing', label: 'En cours' },
            { id: 'done', label: 'Terminé' },
          ]}
          onChange={(v) => run(window.boo.library.updateNote(note.id, { status: v === 'auto' ? null : v }))}
        />
      </Section>

      <Section
        title={`Supports${note.resources.length ? ` (${note.resources.length})` : ''}`}
        action={<Button size="s" variant="plain" icon="plus" onPress={onLink} aria-label="Lier un support">Lier</Button>}
      >
        {note.resources.length ? (
          <ul className="insp-list">
            {note.resources.map((id, i) => {
              const r = resources.get(id);
              if (!r) return null;
              return (
                <li key={id} className={`insp-res${id === activeResource ? ' active' : ''}`}>
                  <AriaButton className="insp-res-main" onPress={() => onSelectResource(id)}>
                    {note.resources.length > 1 ? (
                      <span className="tab-badge" style={{ ['--res-hue' as string]: BADGE_HUES[i % BADGE_HUES.length] }}>
                        {i + 1}
                      </span>
                    ) : null}
                    <Icon name={KIND_ICON[r.kind]} size={15} />
                    <span className="insp-res-text">
                      <span className="insp-res-title">{r.title}</span>
                      <small>{[i === 0 ? 'principal' : '', KIND_LABELS[r.kind], r.positionLabel].filter(Boolean).join(' · ')}</small>
                    </span>
                  </AriaButton>
                  <MenuButton
                    label={`Actions du support ${r.title}`}
                    entries={[
                      {
                        id: 'primary',
                        label: 'Définir comme principal',
                        icon: 'star',
                        disabled: i === 0 || note.origin !== 'desktop',
                        onAction: () => run(window.boo.library.setPrimaryResource(note.id, id)),
                      },
                      { id: 'source', label: r.origin === 'file' ? 'Afficher le fichier' : 'Ouvrir dans le navigateur', icon: 'popout', onAction: () => run(window.boo.library.openSource(id)) },
                      'separator',
                      {
                        id: 'unlink',
                        label: 'Retirer de la note',
                        icon: 'unlink',
                        danger: true,
                        disabled: note.origin === 'extension' && i === 0,
                        onAction: () => run(window.boo.library.unlinkResource(note.id, id)),
                      },
                    ]}
                  />
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="insp-empty">Aucun support : une fiche libre. Liez une vidéo, un audio, un PDF, une image…</p>
        )}
      </Section>

      <Section title={`Liens${note.links?.length ? ` (${note.links.length})` : ''}`}>
        {note.links?.length ? (
          <div className="chips">
            {note.links.map((t) => {
              const target = noteByTitle(notes.values(), t);
              return (
                <AriaButton key={t} className={`link-chip${target ? '' : ' missing'}`} onPress={() => void openTitle(t)}>
                  <Icon name={target ? KIND_ICON[target.kind] : 'plus'} size={12} />
                  {t}
                </AriaButton>
              );
            })}
          </div>
        ) : (
          <p className="insp-empty">Tapez [[ dans la note pour lier une autre note.</p>
        )}
      </Section>

      <Section title={`Liée depuis${backlinks.length ? ` (${backlinks.length})` : ''}`}>
        {backlinks.length ? (
          <div className="chips">
            {backlinks.map((b) => (
              <AriaButton key={b.id} className="link-chip" onPress={() => go({ name: 'note', id: b.id })}>
                <Icon name={KIND_ICON[b.kind]} size={12} />
                {b.title}
              </AriaButton>
            ))}
          </div>
        ) : (
          <p className="insp-empty">Aucune note ne renvoie ici pour l’instant.</p>
        )}
      </Section>

      <Section title="Révision">
        {note.review ? (
          <p className="insp-text">
            {note.due ? <strong className="warn-text">À réviser aujourd’hui</strong> : <>Prochaine révision {dueLabel(note.review.next)}</>}
            <br />
            <small>
              Intervalle : {note.review.interval || 0} j · {note.review.count} réussite{note.review.count > 1 ? 's' : ''} d’affilée
            </small>
          </p>
        ) : (
          <Button size="s" variant="tinted" icon="cards" onPress={() => run(window.boo.library.review(note.id, 'start'))}>
            Ajouter aux révisions
          </Button>
        )}
      </Section>

      <Section title={`Cartes${cards.length ? ` (${cards.length})` : ''}`}>
        {cards.length ? (
          <ul className="insp-cards">
            {cards.slice(0, 6).map((c) => (
              <li key={c.id}>
                <span className="q">{c.type === 'cloze' ? c.front.replace(/\{\{c\d+::(.+?)\}\}/g, '[…]') : c.front}</span>
                {c.type === 'basic' ? <span className="a">{c.back}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="insp-empty">
            Écrivez <code>Question :: Réponse</code> ou <code>==mot==</code> : ces cartes rejoignent l’export (Anki, fiches, QCM).
          </p>
        )}
      </Section>

      {status?.notion.connected ? (
        <Section title="Notion">
          <p className="insp-text">
            {note.notion?.error ? (
              <span className="warn-text">{note.notion.error}</span>
            ) : note.notion ? (
              <>Synchronisée {relativeTime(note.notion.syncedAt)}</>
            ) : (
              'Pas encore dans Notion'
            )}
          </p>
          <div className="insp-row">
            <Button size="s" variant="glass" icon="refresh" onPress={() => run(window.boo.notion.syncItem(note.id).then(() => toast('Note synchronisée avec Notion', 'success')))}>
              Synchroniser
            </Button>
            {note.notion?.url ? (
              <Button size="s" variant="plain" icon="popout" onPress={() => run(window.boo.notion.open(note.id))}>
                Ouvrir
              </Button>
            ) : null}
          </div>
        </Section>
      ) : null}
      {course ? (
        <p className="insp-foot" style={{ ['--course' as string]: courseColor(course.hue) }}>
          <span className="tree-dot" /> {course.title}
        </p>
      ) : null}
    </div>
  );
}
