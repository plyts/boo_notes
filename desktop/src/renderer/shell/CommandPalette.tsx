import { useState } from 'react';
import {
  Autocomplete,
  Dialog,
  Header,
  Input,
  Menu,
  MenuItem,
  MenuSection,
  Modal,
  ModalOverlay,
  SearchField,
  Text,
} from 'react-aria-components';
import { newCourse, newNote } from '../actions';
import { KIND_ICON, KIND_LABELS } from '../lib/kinds';
import { useApp, type Route } from '../store';
import { Icon, type IconName } from '../ui';
import { addFiles } from './App';

interface Entry {
  id: string;
  label: string;
  detail?: string;
  icon: IconName;
  keywords?: string;
  run(): void;
}

const fold = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** Every word typed must appear (in any order, accents ignored). */
function matches(text: string, query: string): boolean {
  const t = fold(text);
  return fold(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => t.includes(w));
}

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const setOpen = useApp((s) => s.setPalette);
  const snap = useApp((s) => s.snap);
  const courses = useApp((s) => s.courses);
  const go = useApp((s) => s.go);
  const setExport = useApp((s) => s.setExport);
  const setUrlOpen = useApp((s) => s.setUrlOpen);
  const [query, setQuery] = useState('');

  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const to = (route: Route) => () => go(route);

  const actions: Entry[] = [
    { id: 'a:note', label: 'Nouvelle note', icon: 'edit', keywords: 'fiche créer', run: () => void newNote() },
    { id: 'a:course', label: 'Nouveau cours', icon: 'course', keywords: 'créer chapitre', run: () => void newCourse() },
    { id: 'a:files', label: 'Ajouter des supports…', icon: 'plus', keywords: 'pdf vidéo audio image fichier importer', run: () => void addFiles() },
    { id: 'a:url', label: 'Ouvrir un flux ou une adresse…', icon: 'broadcast', keywords: 'url lien stream radio hls m3u8 podcast', run: () => setUrlOpen(true) },
    { id: 'a:graph', label: 'Carte mentale', icon: 'mindmap', keywords: 'graphe réseau liens second cerveau', run: to({ name: 'graph' }) },
    { id: 'a:review', label: 'Réviser', icon: 'cards', keywords: 'révision répétition espacée', run: to({ name: 'review' }) },
    { id: 'a:export', label: 'Exporter mes cours…', icon: 'export', keywords: 'fiches anki pdf markdown json qcm', run: () => setExport(true) },
    { id: 'a:settings', label: 'Réglages', icon: 'settings', keywords: 'préférences notion extension', run: to({ name: 'settings' }) },
  ];
  const courseEntries: Entry[] = snap.courses.map((c) => ({
    id: `c:${c.id}`,
    label: `${c.emoji} ${c.title}`,
    detail: `${c.chapters.length} chapitre${c.chapters.length > 1 ? 's' : ''} · ${c.noteCount} note${c.noteCount > 1 ? 's' : ''}`,
    icon: 'course',
    keywords: c.chapters.map((ch) => ch.title).join(' '),
    run: to({ name: 'course', id: c.id }),
  }));
  const noteEntries: Entry[] = snap.notes.map((n) => {
    const course = n.courseId ? courses.get(n.courseId) : undefined;
    const chapter = course?.chapters.find((c) => c.id === n.chapterId);
    return {
      id: `n:${n.id}`,
      label: n.title,
      detail: course ? `${course.title}${chapter ? ` › ${chapter.title}` : ''}` : KIND_LABELS[n.kind],
      icon: KIND_ICON[n.kind],
      run: to({ name: 'note', id: n.id }),
    };
  });
  const resourceEntries: Entry[] = snap.resources.map((r) => ({
    id: `r:${r.id}`,
    label: r.title,
    detail: `${KIND_LABELS[r.kind]}${r.notes.length ? ` · ${r.notes.length} note${r.notes.length > 1 ? 's' : ''}` : ''}`,
    icon: KIND_ICON[r.kind],
    run: () => {
      const note = r.notes[0];
      if (note) go({ name: 'note', id: note, resource: r.id });
      else go({ name: 'resources', kind: r.kind });
    },
  }));
  const byId = new Map([...actions, ...courseEntries, ...noteEntries, ...resourceEntries].map((e) => [e.id, e]));
  const sections: Array<[string, Entry[]]> = [
    ['Actions', actions],
    ['Cours', courseEntries],
    ['Notes', noteEntries.slice(0, query ? 50 : 8)],
    ['Supports', resourceEntries.slice(0, query ? 30 : 0)],
  ];

  return (
    <ModalOverlay isOpen={open} onOpenChange={(o) => (o ? setOpen(true) : close())} isDismissable className="palette-overlay">
      <Modal className="palette glass-thick">
        <Dialog className="palette-dialog" aria-label="Rechercher et agir">
          <Autocomplete
            inputValue={query}
            onInputChange={setQuery}
            filter={(textValue, input) => !input.trim() || matches(textValue, input)}
          >
            <SearchField aria-label="Rechercher" className="palette-search" autoFocus>
              <Icon name="search" size={18} />
              <Input className="palette-input" placeholder="Rechercher une note, un cours, un support, une action…" />
            </SearchField>
            <Menu
              className="palette-list"
              aria-label="Résultats"
              onAction={(key) => {
                const entry = byId.get(String(key));
                close();
                entry?.run();
              }}
              renderEmptyState={() => <p className="palette-empty">Aucun résultat pour « {query} »</p>}
            >
              {sections
                .filter(([, entries]) => entries.length)
                .map(([title, entries]) => (
                  <MenuSection key={title} className="palette-section">
                    <Header className="palette-header">{title}</Header>
                    {entries.map((e) => (
                      <MenuItem key={e.id} id={e.id} textValue={`${e.label} ${e.detail ?? ''} ${e.keywords ?? ''}`} className="palette-item">
                        <span className="palette-icon">
                          <Icon name={e.icon} size={16} />
                        </span>
                        <Text slot="label" className="palette-label">
                          {e.label}
                        </Text>
                        {e.detail ? (
                          <Text slot="description" className="palette-detail">
                            {e.detail}
                          </Text>
                        ) : null}
                      </MenuItem>
                    ))}
                  </MenuSection>
                ))}
            </Menu>
          </Autocomplete>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
