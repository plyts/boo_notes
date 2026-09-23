import { Button as AriaButton } from 'react-aria-components';
import { newCourse, newNote } from '../actions';
import { greeting, plural } from '../lib/format';
import { courseColor, KIND_ICON } from '../lib/kinds';
import { addFiles } from '../shell/App';
import { LargeTitle, PageHeader } from '../shell/PageHeader';
import { useApp } from '../store';
import { Button, Icon, Ring, type IconName } from '../ui';
import { KindBadge, NoteList } from './parts';

function QuickAction({ icon, label, hint, onPress }: { icon: IconName; label: string; hint: string; onPress(): void }) {
  return (
    <AriaButton className="quick-action glass" onPress={onPress}>
      <span className="quick-icon">
        <Icon name={icon} size={20} />
      </span>
      <span className="quick-text">
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
    </AriaButton>
  );
}

export function TodayView() {
  const snap = useApp((s) => s.snap);
  const resources = useApp((s) => s.resources);
  const go = useApp((s) => s.go);
  const setUrlOpen = useApp((s) => s.setUrlOpen);
  const mod = window.boo.platform === 'darwin' ? '⌘' : 'Ctrl';
  const due = snap.notes.filter((n) => n.due);
  const resume = snap.notes
    .filter((n) => n.studyStatus === 'doing' && n.resources.length && n.ratio > 0 && n.ratio < 1)
    .sort((a, b) => (resources.get(b.resources[0])?.progress?.updatedAt ?? 0) - (resources.get(a.resources[0])?.progress?.updatedAt ?? 0))
    .slice(0, 4);
  const recent = snap.notes.slice(0, 8);
  const today = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  const empty = !snap.notes.length && !snap.courses.length;

  return (
    <div className="page">
      <PageHeader actions={<Button variant="primary" icon="edit" onPress={() => void newNote()}>Nouvelle note</Button>} />
      <div className="page-content">
        <LargeTitle
          title={greeting()}
          subtitle={
            <>
              <span className="capitalize">{today}</span>
              {due.length ? ` · ${plural(due.length, 'note')} à réviser` : ''}
            </>
          }
        />

        <div className="quick-actions">
          <QuickAction icon="edit" label="Nouvelle note" hint={`Fiche libre · ${mod} N`} onPress={() => void newNote()} />
          <QuickAction icon="plus" label="Ajouter des supports" hint={`PDF, vidéo, audio, image · ${mod} O`} onPress={() => void addFiles()} />
          <QuickAction icon="broadcast" label="Ouvrir un flux" hint="Adresse d’une vidéo, d’un audio, d’une radio" onPress={() => setUrlOpen(true)} />
          <QuickAction icon="course" label="Nouveau cours" hint="Des chapitres, des notes" onPress={() => void newCourse()} />
        </div>

        {empty ? (
          <section className="welcome glass">
            <Icon name="ghost" size={36} />
            <h2>Votre second cerveau commence ici</h2>
            <p>
              Créez un cours et ses chapitres, ajoutez vos supports — vidéos, audios, PDF, images, pages web — et prenez des notes
              qui y restent liées. Reliez vos notes par <code>[[liens]]</code> : la carte mentale les rassemble.
            </p>
          </section>
        ) : null}

        {due.length ? (
          <section className="section">
            <div className="section-head">
              <h2>À réviser aujourd’hui</h2>
              <Button variant="tinted" icon="cards" onPress={() => go({ name: 'review' })}>
                Réviser ({due.length})
              </Button>
            </div>
            <div className="card-row">
              {due.slice(0, 6).map((n) => (
                <AriaButton key={n.id} className="note-card" onPress={() => go({ name: 'note', id: n.id })}>
                  <KindBadge kind={n.kind} size={28} />
                  <strong>{n.title}</strong>
                  <small>{n.links?.length ? plural(n.links.length, 'lien') : 'Fiche'}</small>
                </AriaButton>
              ))}
            </div>
          </section>
        ) : null}

        {resume.length ? (
          <section className="section">
            <div className="section-head">
              <h2>Reprendre</h2>
            </div>
            <div className="card-row">
              {resume.map((n) => {
                const course = n.courseId ? snap.courses.find((c) => c.id === n.courseId) : undefined;
                return (
                  <AriaButton key={n.id} className="resume-card" onPress={() => go({ name: 'note', id: n.id })}>
                    <span className="resume-top">
                      <Icon name={KIND_ICON[n.kind]} size={16} />
                      <span>{n.positionLabel}</span>
                    </span>
                    <strong>{n.title}</strong>
                    <span className="resume-foot">
                      <Ring value={n.ratio} size={20} stroke={3} color={course ? courseColor(course.hue) : undefined} />
                      <small>{course ? `${course.emoji} ${course.title}` : 'Non classée'}</small>
                    </span>
                  </AriaButton>
                );
              })}
            </div>
          </section>
        ) : null}

        {snap.courses.length ? (
          <section className="section">
            <div className="section-head">
              <h2>Vos cours</h2>
              <Button variant="plain" icon="mindmap" onPress={() => go({ name: 'graph' })}>
                Carte mentale
              </Button>
            </div>
            <div className="course-grid">
              {snap.courses.map((c) => (
                <AriaButton key={c.id} className="course-card" style={{ ['--course' as string]: courseColor(c.hue) }} onPress={() => go({ name: 'course', id: c.id })}>
                  <span className="course-card-top">
                    <span className="course-emoji">{c.emoji}</span>
                    <Ring value={c.ratio} size={34} stroke={4} color={courseColor(c.hue)} />
                  </span>
                  <strong>{c.title}</strong>
                  <small>
                    {plural(c.chapters.length, 'chapitre')} · {plural(c.noteCount, 'note')}
                    {c.dueCount ? ` · ${c.dueCount} à réviser` : ''}
                  </small>
                </AriaButton>
              ))}
              <AriaButton className="course-card course-card-new" onPress={() => void newCourse()}>
                <Icon name="plus" size={22} />
                <strong>Nouveau cours</strong>
              </AriaButton>
            </div>
          </section>
        ) : null}

        {recent.length ? (
          <section className="section">
            <div className="section-head">
              <h2>Récemment modifiées</h2>
              <Button variant="plain" onPress={() => go({ name: 'notes', filter: 'all' })}>
                Tout voir
              </Button>
            </div>
            <NoteList notes={recent} label="Notes récentes" />
          </section>
        ) : null}
      </div>
    </div>
  );
}
