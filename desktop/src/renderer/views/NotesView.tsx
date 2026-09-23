import { useMemo, useState } from 'react';
import type { MediaKind } from '../../../../src/shared/platforms';
import { newNote } from '../actions';
import { plural } from '../lib/format';
import { KIND_PLURALS } from '../lib/kinds';
import { LargeTitle, PageHeader } from '../shell/PageHeader';
import { useApp } from '../store';
import { Button, SearchField, Segmented } from '../ui';
import { NoteList } from './parts';

const fold = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

type Sort = 'recent' | 'title' | 'progress';

export function NotesView({ filter }: { filter: 'all' | 'inbox' | 'due' }) {
  const snap = useApp((s) => s.snap);
  const courses = useApp((s) => s.courses);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<MediaKind | 'all'>('all');
  const [sort, setSort] = useState<Sort>('recent');

  const base = filter === 'inbox' ? snap.notes.filter((n) => !n.courseId) : filter === 'due' ? snap.notes.filter((n) => n.due) : snap.notes;
  const kinds = [...new Set(base.map((n) => n.kind))];
  const notes = useMemo(() => {
    const q = fold(query.trim());
    const list = base.filter((n) => {
      if (kind !== 'all' && n.kind !== kind) return false;
      if (!q) return true;
      const course = n.courseId ? courses.get(n.courseId) : undefined;
      return fold(`${n.title} ${course?.title ?? ''} ${n.source}`).includes(q);
    });
    if (sort === 'title') return [...list].sort((a, b) => a.title.localeCompare(b.title, 'fr'));
    if (sort === 'progress') return [...list].sort((a, b) => b.ratio - a.ratio);
    return list;
  }, [base, kind, query, sort, courses]);

  const title = filter === 'inbox' ? 'Non classées' : filter === 'due' ? 'À réviser' : 'Toutes les notes';
  const subtitle =
    filter === 'inbox'
      ? 'Glissez une note sur un cours ou un chapitre de la barre latérale pour la classer.'
      : `${plural(base.length, 'note')}`;

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ label: title }]}
        actions={
          <Button variant="primary" icon="edit" onPress={() => void newNote(undefined)}>
            Nouvelle note
          </Button>
        }
      />
      <div className="page-content">
        <LargeTitle title={title} subtitle={subtitle} />
        <div className="filters">
          <SearchField value={query} onChange={setQuery} label="Filtrer les notes" placeholder="Filtrer par titre, cours, source…" />
          {kinds.length > 1 ? (
            <Segmented<MediaKind | 'all'>
              label="Type"
              value={kind}
              onChange={setKind}
              options={[{ id: 'all', label: 'Tout' }, ...kinds.map((k) => ({ id: k, label: KIND_PLURALS[k] }))]}
            />
          ) : null}
          <span className="toolbar-spacer" />
          <Segmented<Sort>
            label="Trier"
            value={sort}
            onChange={setSort}
            options={[
              { id: 'recent', label: 'Récentes' },
              { id: 'title', label: 'A → Z' },
              { id: 'progress', label: 'Progression' },
            ]}
          />
        </div>
        <NoteList
          notes={notes}
          label={title}
          showPlace={filter !== 'inbox'}
          empty={
            query
              ? `Aucune note ne correspond à « ${query} ».`
              : filter === 'inbox'
                ? 'Toutes vos notes sont classées. 🎉'
                : 'Aucune note pour l’instant : Ctrl+N pour en créer une.'
          }
        />
      </div>
    </div>
  );
}
