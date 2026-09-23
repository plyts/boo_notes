import { useState } from 'react';
import type { ResourceKind } from '../../ipc';
import { currentPlacement } from '../actions';
import { errorMessage } from '../lib/format';
import { useApp } from '../store';
import { Button, Icon, Segmented, Sheet, TextField, toast } from '../ui';

const EXAMPLES = [
  { label: 'Vidéo ou audio direct', hint: '.mp4 .webm .mp3 .m4a .ogg .wav' },
  { label: 'Flux adaptatif, radio, live', hint: '.m3u8 (HLS), Icecast, podcasts' },
  { label: 'Document en ligne', hint: 'PDF, image' },
  { label: 'Page d’une plateforme', hint: 'YouTube, Udemy, Coursera… (ouverte dans le navigateur)' },
];

/** Opens any stream or document by its address, with a new note about it. */
export function UrlSheet() {
  const open = useApp((s) => s.urlOpen);
  const setOpen = useApp((s) => s.setUrlOpen);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<ResourceKind | 'auto'>('auto');
  const [busy, setBusy] = useState(false);
  const valid = /^https?:\/\/\S+/i.test(url.trim());

  const submit = async () => {
    setBusy(true);
    try {
      const res = await window.boo.library.addUrl(url.trim(), { title: title.trim() || undefined, kind: kind === 'auto' ? undefined : kind });
      const { refresh, go } = useApp.getState();
      if (res.notes.length) {
        await refresh();
        go({ name: 'note', id: res.notes[0], resource: res.id });
      } else {
        const note = await window.boo.library.createNote({ title: res.title, resources: [res.id], placement: currentPlacement() });
        await refresh();
        go({ name: 'note', id: note.id });
      }
      setUrl('');
      setTitle('');
      setKind('auto');
      setOpen(false);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet isOpen={open} onOpenChange={setOpen} title="Ouvrir un flux ou une adresse">
      <form
        className="form-stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void submit();
        }}
      >
        <TextField label="Adresse" value={url} onChange={setUrl} placeholder="https://…" autoFocus />
        <TextField label="Titre (facultatif)" value={title} onChange={setTitle} placeholder="Sinon, déduit de l’adresse" />
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
        <ul className="url-examples">
          {EXAMPLES.map((e) => (
            <li key={e.label}>
              <Icon name="check" size={12} />
              <span>
                <strong>{e.label}</strong> <small>{e.hint}</small>
              </span>
            </li>
          ))}
        </ul>
        <p className="set-desc">
          Une note est créée pour ce support, dans le chapitre ouvert. Ses instants <code>[04:15]</code> relancent la lecture au bon moment.
        </p>
        <div className="sheet-actions">
          <Button variant="plain" onPress={() => setOpen(false)}>
            Annuler
          </Button>
          <Button type="submit" variant="primary" icon="broadcast" isDisabled={!valid || busy}>
            {busy ? 'Ouverture…' : 'Ouvrir'}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
