import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../lib/format';
import { toast } from '../ui';

/**
 * A title edited in place: click (or Enter) to edit, Enter to save, Escape to
 * cancel — like renaming a document in a macOS title bar.
 */
export function EditableTitle({
  value,
  label,
  onSave,
  readOnly = false,
}: {
  value: string;
  label: string;
  onSave(value: string): Promise<unknown>;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const save = async () => {
    setEditing(false);
    const v = draft.trim();
    if (!v || v === value) return;
    try {
      await onSave(v);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  if (readOnly) return <span>{value}</span>;
  if (editing) {
    return (
      <input
        ref={input}
        className="title-input"
        aria-label={label}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void save();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setDraft(value);
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <button type="button" className="title-button" title="Renommer" aria-label={`${label} : ${value} (renommer)`} onClick={() => setEditing(true)}>
      {value}
    </button>
  );
}
