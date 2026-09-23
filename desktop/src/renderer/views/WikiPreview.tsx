import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { plainText } from '../../../../src/shared/cards';
import { KIND_ICON, KIND_LABELS } from '../lib/kinds';
import { noteByTitle, useApp } from '../store';
import { Icon } from '../ui';

/** Hover card of a `[[Titre]]` link: the beginning of the linked note (or an invitation to create it). */
export function WikiPreview({ title, anchor, onClose }: { title: string; anchor: HTMLElement; onClose(): void }) {
  const notes = useApp((s) => s.notes);
  const note = noteByTitle(notes.values(), title);
  const [body, setBody] = useState<string | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  useEffect(() => {
    let cancelled = false;
    setBody(null);
    if (note) void window.boo.library.readNote(note.id).then((md) => !cancelled && setBody(plainText(md).slice(0, 360)));
    return () => {
      cancelled = true;
    };
  }, [note]);

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const w = card.current?.offsetWidth ?? 320;
    const h = card.current?.offsetHeight ?? 140;
    const below = r.bottom + 8 + h < window.innerHeight;
    setPos({ left: Math.max(8, Math.min(window.innerWidth - w - 8, r.left)), top: below ? r.bottom + 8 : r.top - h - 8 });
  }, [anchor, body]);

  useEffect(() => {
    const leave = (e: MouseEvent) => {
      const t = e.relatedTarget as Node | null;
      if (!t || (!anchor.contains(t) && !card.current?.contains(t))) onClose();
    };
    anchor.addEventListener('mouseleave', leave);
    return () => anchor.removeEventListener('mouseleave', leave);
  }, [anchor, onClose]);

  return (
    <div ref={card} className="wiki-preview glass-thick" role="tooltip" style={{ left: pos.left, top: pos.top }} onMouseLeave={onClose}>
      {note ? (
        <>
          <p className="wiki-kind">
            <Icon name={KIND_ICON[note.kind]} size={13} /> {note.resources.length ? KIND_LABELS[note.kind] : 'Fiche'}
          </p>
          <strong className="wiki-title">{note.title}</strong>
          <p className="wiki-body">{body === null ? '…' : body || 'Note vide.'}</p>
        </>
      ) : (
        <>
          <strong className="wiki-title">{title}</strong>
          <p className="wiki-body">Cette note n’existe pas encore : cliquez pour la créer.</p>
        </>
      )}
    </div>
  );
}
