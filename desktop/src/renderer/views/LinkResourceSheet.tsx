import { useMemo, useState } from 'react';
import { GridList, GridListItem, Tab, TabList, TabPanel, Tabs } from 'react-aria-components';
import type { NoteView, ResourceKind } from '../../ipc';
import { errorMessage } from '../lib/format';
import { KIND_ICON, KIND_LABELS } from '../lib/kinds';
import { useApp } from '../store';
import { Button, Icon, SearchField, Segmented, Sheet, TextField, toast } from '../ui';

const fold = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** Links resources to a note: files, an address (stream, remote document, page), or resources already in the library. */
export function LinkResourceSheet({
  note,
  isOpen,
  onOpenChange,
  onLinked,
}: {
  note: NoteView;
  isOpen: boolean;
  onOpenChange(open: boolean): void;
  onLinked(resourceId: string): void;
}) {
  const snap = useApp((s) => s.snap);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<ResourceKind | 'auto'>('auto');
  const [query, setQuery] = useState('');
  const available = useMemo(
    () =>
      snap.resources.filter((r) => !note.resources.includes(r.id) && (!query.trim() || fold(`${r.title} ${r.source}`).includes(fold(query.trim())))),
    [snap.resources, note.resources, query],
  );

  const link = async (ids: string[]) => {
    try {
      for (const id of ids) await window.boo.library.linkResource(note.id, id);
      if (ids.length) {
        onLinked(ids.at(-1)!);
        toast(ids.length > 1 ? `${ids.length} supports liés` : 'Support lié à la note', 'success');
      }
      onOpenChange(false);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const files = async () => {
    const { resources, errors } = await window.boo.library.pickResources();
    if (errors.length) toast(errors[0], 'error');
    await link(resources.map((r) => r.id));
  };

  const address = async () => {
    try {
      const res = await window.boo.library.addUrl(url, { title: title || undefined, kind: kind === 'auto' ? undefined : kind });
      setUrl('');
      setTitle('');
      await link([res.id]);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <Sheet isOpen={isOpen} onOpenChange={onOpenChange} title="Lier un support" wide>
      <p className="sheet-lede">
        Une note peut s’appuyer sur plusieurs supports : ses repères (<code>[04:15]</code>, <code>[p. 12]</code>, <code>[pin 3]</code>…) renvoient
        chacun au bon support.
      </p>
      <Tabs className="sheet-tabs">
        <TabList aria-label="Source du support" className="segmented">
          <Tab id="files" className="segment">
            <Icon name="folder" size={14} /> Fichiers
          </Tab>
          <Tab id="url" className="segment">
            <Icon name="broadcast" size={14} /> Adresse ou flux
          </Tab>
          <Tab id="library" className="segment">
            <Icon name="library" size={14} /> Bibliothèque
          </Tab>
        </TabList>
        <TabPanel id="files" className="sheet-panel">
          <p>PDF, vidéo, audio, image, texte : choisissez un ou plusieurs fichiers de votre ordinateur.</p>
          <Button variant="primary" icon="folder" onPress={() => void files()}>
            Choisir des fichiers…
          </Button>
        </TabPanel>
        <TabPanel id="url" className="sheet-panel">
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              void address();
            }}
          >
            <TextField
              label="Adresse"
              value={url}
              onChange={setUrl}
              placeholder="https://… (.mp4, .mp3, .m3u8, radio, PDF, YouTube, Coursera…)"
              description="Vidéos et audios directs, flux HLS et radios se lisent dans l’app ; les pages (YouTube, Udemy…) s’ouvrent dans le navigateur, où l’extension prend les notes."
              autoFocus
            />
            <TextField label="Titre (facultatif)" value={title} onChange={setTitle} placeholder="Nom affiché dans la note" />
            <Segmented<ResourceKind | 'auto'>
              label="Type"
              value={kind}
              onChange={setKind}
              options={[
                { id: 'auto', label: 'Auto' },
                { id: 'video', label: 'Vidéo' },
                { id: 'audio', label: 'Audio' },
                { id: 'pdf', label: 'PDF' },
                { id: 'image', label: 'Image' },
                { id: 'page', label: 'Page' },
              ]}
            />
            <div className="sheet-actions">
              <Button type="submit" variant="primary" icon="link" isDisabled={!/^https?:\/\/\S+/.test(url)}>
                Lier cette adresse
              </Button>
            </div>
          </form>
        </TabPanel>
        <TabPanel id="library" className="sheet-panel">
          <SearchField value={query} onChange={setQuery} label="Chercher un support" placeholder="Chercher un support…" />
          <GridList
            aria-label="Supports de la bibliothèque"
            className="rows compact"
            items={available}
            selectionMode="none"
            onAction={(key) => void link([String(key)])}
            renderEmptyState={() => <div className="rows-empty">Aucun autre support dans la bibliothèque.</div>}
          >
            {(r) => (
              <GridListItem id={r.id} textValue={r.title} className="row">
                <Icon name={KIND_ICON[r.kind]} size={16} />
                <span className="row-text">
                  <span className="row-title">{r.title}</span>
                  <span className="row-meta">
                    {KIND_LABELS[r.kind]}
                    {r.notes.length ? ` · ${r.notes.length} note${r.notes.length > 1 ? 's' : ''}` : ''}
                  </span>
                </span>
                <Icon name="plus" size={14} />
              </GridListItem>
            )}
          </GridList>
        </TabPanel>
      </Tabs>
    </Sheet>
  );
}
