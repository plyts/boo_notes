import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { extractCards, plainText, type Flashcard } from '../../../../src/shared/cards';
import { nextInterval, type ReviewGrade } from '../../../../src/shared/study';
import type { NoteView } from '../../ipc';
import { dueLabel, errorMessage, plural } from '../lib/format';
import { courseColor } from '../lib/kinds';
import { LargeTitle, PageHeader } from '../shell/PageHeader';
import { useApp } from '../store';
import { Bar, Button, Icon, toast } from '../ui';
import { KindBadge } from './parts';

const GRADES: Array<{ grade: ReviewGrade; label: string; key: string; variant: 'danger' | 'glass' | 'tinted' }> = [
  { grade: 'again', label: 'À revoir', key: '1', variant: 'danger' },
  { grade: 'good', label: 'Je sais', key: '2', variant: 'glass' },
  { grade: 'easy', label: 'Facile', key: '3', variant: 'tinted' },
];

const inDays = (d: number) => (d <= 1 ? 'demain' : d < 30 ? `dans ${d} j` : `dans ${Math.round(d / 30)} mois`);

/** A cloze sentence, words hidden (question) or revealed (answer). */
function Cloze({ text, reveal }: { text: string; reveal: boolean }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/\{\{c\d+::(.+?)\}\}/g)) {
    parts.push(text.slice(last, m.index));
    parts.push(
      <mark key={m.index} className={reveal ? 'cloze shown' : 'cloze'}>
        {reveal ? m[1] : '…'}
      </mark>,
    );
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

/**
 * Review session of the day: each due note, its flashcards one by one (or the
 * sheet to reread), then « À revoir / Je sais / Facile » schedules the next
 * review (1, 3, 7, 14, 30… days).
 */
export function ReviewView() {
  const notes = useApp((s) => s.snap.notes);
  const courses = useApp((s) => s.courses);
  const go = useApp((s) => s.go);
  const [practice, setPractice] = useState(false);
  // The queue is fixed when the session starts: grading a note must not reshuffle it.
  const [queue, setQueue] = useState<string[] | null>(null);
  const [pos, setPos] = useState(0);
  const [done, setDone] = useState<Record<ReviewGrade, number>>({ again: 0, good: 0, easy: 0 });

  const due = useMemo(() => notes.filter((n) => n.due).sort((a, b) => (a.review?.next ?? 0) - (b.review?.next ?? 0)), [notes]);
  const planned = useMemo(
    () => notes.filter((n) => n.review && !n.due).sort((a, b) => (a.review!.next ?? 0) - (b.review!.next ?? 0)),
    [notes],
  );

  const start = (ids: string[], isPractice: boolean) => {
    setPractice(isPractice);
    setQueue(ids);
    setPos(0);
    setDone({ again: 0, good: 0, easy: 0 });
  };

  const current = queue && pos < queue.length ? notes.find((n) => n.id === queue[pos]) : undefined;
  const finished = queue !== null && pos >= queue.length;
  const reviewed = done.again + done.good + done.easy;

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ label: 'Révisions', route: queue ? { name: 'review' } : undefined }]}
        actions={
          queue && !finished ? (
            <Button variant="plain" icon="close" onPress={() => setQueue(null)}>
              Terminer
            </Button>
          ) : null
        }
      />
      <div className="page-content page-narrow">
        {!queue ? (
          <>
            <LargeTitle
              title="Révisions"
              subtitle={
                due.length
                  ? `${plural(due.length, 'fiche')} à réviser aujourd’hui`
                  : planned.length
                    ? 'Rien à réviser aujourd’hui : profitez-en pour avancer.'
                    : 'Ajoutez une note aux révisions depuis son inspecteur.'
              }
            />
            <section className="review-hero glass">
              <Icon name="cards" size={30} />
              <div>
                <h2>{due.length ? 'Session du jour' : 'Tout est à jour'}</h2>
                <p>
                  Chaque fiche montre ses cartes (<code>Question :: Réponse</code>, <code>==mot caché==</code>, <code>## Titre ?</code>) : répondez de
                  tête, retournez la carte, puis notez-vous. Les intervalles s’allongent quand vous savez.
                </p>
              </div>
              <div className="review-hero-actions">
                <Button variant="primary" icon="play" isDisabled={!due.length} onPress={() => start(due.map((n) => n.id), false)}>
                  {due.length ? `Réviser (${due.length})` : 'Réviser'}
                </Button>
                {planned.length ? (
                  <Button icon="replay" onPress={() => start(planned.map((n) => n.id), true)}>
                    S’entraîner quand même
                  </Button>
                ) : null}
              </div>
            </section>
            {planned.length ? (
              <section className="section">
                <div className="section-head">
                  <h2>Prochaines révisions</h2>
                </div>
                <ul className="upcoming">
                  {planned.slice(0, 12).map((n) => {
                    const c = n.courseId ? courses.get(n.courseId) : undefined;
                    return (
                      <li key={n.id}>
                        <button type="button" className="upcoming-row" onClick={() => go({ name: 'note', id: n.id })}>
                          <KindBadge kind={n.kind} size={24} />
                          <span className="row-text">
                            <span className="row-title">{n.title}</span>
                            <span className="row-meta">{c ? `${c.emoji} ${c.title}` : 'Non classée'}</span>
                          </span>
                          <span className="upcoming-when">{dueLabel(n.review!.next)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}
          </>
        ) : finished ? (
          <motion.section className="review-done glass" initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
            <span className="review-done-icon">
              <Icon name="check" size={30} />
            </span>
            <h2>{practice ? 'Entraînement terminé' : 'Révision terminée'}</h2>
            <p>
              {plural(reviewed, 'fiche')} : {done.easy} facile{done.easy > 1 ? 's' : ''}, {done.good} sue{done.good > 1 ? 's' : ''}, {done.again} à revoir.
            </p>
            <div className="review-hero-actions">
              <Button variant="primary" onPress={() => setQueue(null)}>
                Retour aux révisions
              </Button>
              <Button onPress={() => go({ name: 'today' })}>Aujourd’hui</Button>
            </div>
          </motion.section>
        ) : current ? (
          <Session
            key={current.id}
            note={current}
            index={pos}
            total={queue.length}
            courseHue={current.courseId ? courses.get(current.courseId)?.hue : undefined}
            onGraded={(g) => {
              setDone((d) => ({ ...d, [g]: d[g] + 1 }));
              setPos((p) => p + 1);
            }}
            onSkip={() => setPos((p) => p + 1)}
          />
        ) : (
          <p className="rows-empty">Cette note n’existe plus.</p>
        )}
      </div>
    </div>
  );
}

function Session({
  note,
  index,
  total,
  courseHue,
  onGraded,
  onSkip,
}: {
  note: NoteView;
  index: number;
  total: number;
  courseHue?: number;
  onGraded(g: ReviewGrade): void;
  onSkip(): void;
}) {
  const go = useApp((s) => s.go);
  const [md, setMd] = useState<string | null>(null);
  const [card, setCard] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void window.boo.library.readNote(note.id).then(setMd, () => setMd(''));
  }, [note.id]);
  const cards: Flashcard[] = useMemo(() => (md ? extractCards(note.id, md) : []), [md, note.id]);
  const lastCard = cards.length === 0 || card >= cards.length - 1;
  const canGrade = cards.length === 0 || (lastCard && revealed);

  const grade = async (g: ReviewGrade) => {
    if (busy) return;
    setBusy(true);
    try {
      await window.boo.library.review(note.id, g);
      onGraded(g);
    } catch (e) {
      toast(errorMessage(e), 'error');
      setBusy(false);
    }
  };
  const advance = () => {
    if (!revealed) setRevealed(true);
    else if (!lastCard) {
      setCard((c) => c + 1);
      setRevealed(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && (e.target.isContentEditable || /INPUT|TEXTAREA/.test(e.target.tagName))) return;
      if (e.key === ' ' || e.key === 'Enter') {
        if (cards.length && !(lastCard && revealed)) {
          e.preventDefault();
          advance();
        }
      } else if (canGrade && ['1', '2', '3'].includes(e.key)) {
        e.preventDefault();
        void grade(GRADES[Number(e.key) - 1].grade);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const c = cards[card];
  return (
    <div className="session" style={{ ['--course' as string]: courseHue !== undefined ? courseColor(courseHue) : 'var(--accent)' }}>
      <div className="session-top">
        <span className="session-count">
          {index + 1} / {total}
        </span>
        <Bar value={index / total} />
      </div>
      <header className="session-head">
        <KindBadge kind={note.kind} size={28} />
        <h2>{note.title}</h2>
        <Button size="s" variant="plain" icon="popout" onPress={() => go({ name: 'note', id: note.id })}>
          Voir la note
        </Button>
      </header>

      {md === null ? (
        <div className="flashcard glass-thick is-loading" aria-busy="true" />
      ) : cards.length ? (
        <>
          <AnimatePresence mode="wait" initial={false}>
            <motion.button
              type="button"
              key={`${card}-${revealed}`}
              className={`flashcard glass-thick${revealed ? ' is-back' : ''}`}
              initial={{ rotateX: -8, opacity: 0, y: 8 }}
              animate={{ rotateX: 0, opacity: 1, y: 0 }}
              exit={{ rotateX: 8, opacity: 0, y: -8, transition: { duration: 0.12 } }}
              onClick={advance}
              aria-label={revealed ? 'Réponse' : 'Question : cliquez pour voir la réponse'}
            >
              <small className="flashcard-side">
                {revealed ? 'Réponse' : 'Question'} · carte {card + 1} / {cards.length}
              </small>
              {c.type === 'cloze' ? (
                <p className="flashcard-text">
                  <Cloze text={c.front} reveal={revealed} />
                </p>
              ) : (
                <>
                  <p className="flashcard-text">{c.front}</p>
                  {revealed ? <p className="flashcard-answer">{c.back}</p> : null}
                </>
              )}
              {!revealed ? <span className="flashcard-hint">Espace pour retourner</span> : !lastCard ? <span className="flashcard-hint">Espace : carte suivante</span> : null}
            </motion.button>
          </AnimatePresence>
        </>
      ) : (
        <div className="flashcard glass-thick is-sheet">
          <small className="flashcard-side">Relisez votre fiche</small>
          <p className="sheet-excerpt">{plainText(md).slice(0, 1400) || 'Fiche vide.'}</p>
          <span className="flashcard-hint">Astuce : écrivez « Question :: Réponse » pour en faire des cartes.</span>
        </div>
      )}

      <div className={`grades${canGrade ? '' : ' is-waiting'}`} aria-hidden={!canGrade}>
        {GRADES.map((g) => (
          <Button key={g.grade} variant={g.variant} size="l" isDisabled={!canGrade || busy} onPress={() => void grade(g.grade)}>
            <span className="grade-label">{g.label}</span>
            <small className="grade-when">
              {inDays(nextInterval(note.review?.interval, g.grade))} · {g.key}
            </small>
          </Button>
        ))}
      </div>
      <div className="session-foot">
        <Button size="s" variant="plain" onPress={onSkip}>
          Passer
        </Button>
      </div>
    </div>
  );
}
