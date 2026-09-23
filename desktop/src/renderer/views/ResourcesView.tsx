import { useMemo, useState } from 'react';
import { GridList, GridListItem } from 'react-aria-components';
import type { ResourceKind, ResourceView } from '../../ipc';
import { currentPlacement } from '../actions';
import { errorMessage, plural } from '../lib/format';
import { KIND_PLURALS } from '../lib/kinds';
import { addFiles } from '../shell/App';
import { LargeTitle, PageHeader } from '../shell/PageHeader';
import { useApp } from '../store';
import { Button, confirm, MenuButton, prompt, SearchField, Segmented, toast } from '../ui';
import { ResourceCardContent } from './parts';

const fold = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** Opens the note of a resource, creating one when it has none. */
export async function openResource(res: ResourceView): Promise<void> {
  const { go, refresh } = useApp.getState();
  try {
    if (res.notes.length) {
      go({ name: 'note', id: res.notes[0], resource: res.id });
      return;
    }
    const note = await window.boo.library.createNote({ title: res.title, resources: [res.id], placement: currentPlacement() });
    await refresh();
    go({ name: 'note', id: note.id });
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

/** Every resource of the library — files, streams, pages — whatever notes use them. */
export function ResourcesView({ kind }: { kind: ResourceKind | 'all' }) {
  const all = useApp((s) => s.snap.resources);
  const go = useApp((s) => s.go);
  const setUrlOpen = useApp((s) => s.setUrlOpen);
  const [query, setQuery] = useState('');
  const [orphans, setOrphans] = useState(false);
  const kinds = [...new Set(all.map((r) => r.kind))];
  const list = useMemo(() => {
    const q = fold(query.trim());
    return all.filter(
      (r) => (kind === 'all' || r.kind === kind) && (!orphans || !r.notes.length) && (!q || fold(`${r.title} ${r.source}`).includes(q)),
    );
  }, [all, kind, query, orphans]);

  const title = kind === 'all' ? 'Supports' : KIND_PLURALS[kind];
  const run = (p: Promise<unknown>) => void p.catch((e: unknown) => toast(errorMessage(e), 'error'));

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ label: 'Supports', route: kind === 'all' ? undefined : { name: 'resources', kind: 'all' } }, ...(kind === 'all' ? [] : [{ label: title }])]}
        actions={
          <>
            <Button icon="broadcast" onPress={() => setUrlOpen(true)}>
              Flux ou adresse
            </Button>
            <Button variant="primary" icon="plus" onPress={() => void addFiles()}>
              Ajouter des fichiers
            </Button>
          </>
        }
      />
      <div className="page-content">
        <LargeTitle
          title={title}
          subtitle={`${plural(all.length, 'support')} · vidéos, audios, flux, PDF, images, textes et pages web. Un support peut servir à plusieurs notes.`}
        />
        <div className="filters">
          <SearchField value={query} onChange={setQuery} label="Filtrer les supports" placeholder="Filtrer par titre ou adresse…" />
          {kinds.length > 1 ? (
            <Segmented<ResourceKind | 'all'>
              label="Type"
              value={kind}
              onChange={(k) => go({ name: 'resources', kind: k }, { replace: true })}
              options={[{ id: 'all', label: 'Tout' }, ...kinds.map((k) => ({ id: k, label: KIND_PLURALS[k] }))]}
            />
          ) : null}
          <span className="toolbar-spacer" />
          <Segmented<'all' | 'orphans'>
            label="Notes"
            value={orphans ? 'orphans' : 'all'}
            onChange={(v) => setOrphans(v === 'orphans')}
            options={[
              { id: 'all', label: 'Tous' },
              { id: 'orphans', label: 'Sans note' },
            ]}
          />
        </div>
        <GridList
          aria-label={title}
          layout="grid"
          className="res-grid"
          items={list}
          selectionMode="none"
          onAction={(key) => {
            const res = list.find((r) => r.id === key);
            if (res) void openResource(res);
          }}
          renderEmptyState={() => (
            <div className="rows-empty">
              {query ? `Aucun support ne correspond à « ${query} ».` : 'Glissez des fichiers dans la fenêtre, ou ouvrez un flux par son adresse.'}
            </div>
          )}
        >
          {(res) => (
            <GridListItem id={res.id} textValue={res.title} className="res-card glass">
              <ResourceCardContent res={res} />
              <span className="res-card-menu">
                <MenuButton
                  label={`Actions de ${res.title}`}
                  entries={[
                    { id: 'open', label: res.notes.length ? 'Ouvrir la note' : 'Créer sa note', icon: 'edit', onAction: () => void openResource(res) },
                    {
                      id: 'source',
                      label: res.origin === 'file' ? 'Afficher le fichier' : 'Ouvrir dans le navigateur',
                      icon: 'popout',
                      onAction: () => run(window.boo.library.openSource(res.id)),
                    },
                    {
                      id: 'rename',
                      label: 'Renommer…',
                      icon: 'edit',
                      onAction: () =>
                        void prompt({ title: 'Renommer le support', value: res.title, confirm: 'Renommer' }).then(
                          (t) => t && run(window.boo.library.updateResource(res.id, { title: t })),
                        ),
                    },
                    'separator',
                    {
                      id: 'remove',
                      label: 'Retirer de la bibliothèque',
                      icon: 'trash',
                      danger: true,
                      onAction: () =>
                        void confirm({
                          title: `Retirer « ${res.title} » ?`,
                          text: res.notes.length
                            ? `Il sera détaché de ${plural(res.notes.length, 'note')}. Vos notes restent, le fichier d’origine n’est pas supprimé.`
                            : 'Le fichier d’origine n’est pas supprimé.',
                          confirm: 'Retirer',
                          danger: true,
                        }).then((r) => r.ok && run(window.boo.library.removeResource(res.id))),
                    },
                  ]}
                />
              </span>
            </GridListItem>
          )}
        </GridList>
      </div>
    </div>
  );
}
