import { useState, type ReactNode } from 'react';
import { Checkbox, Dialog, Heading, Input, Modal, ModalOverlay, TextField } from 'react-aria-components';
import { create } from 'zustand';
import { Button } from './Button';
import { Icon } from './Icon';

/** Modal sheet on thick glass, over a dimmed and blurred window. */
export function Sheet({
  isOpen,
  onOpenChange,
  title,
  children,
  wide = false,
  label,
}: {
  isOpen: boolean;
  onOpenChange(open: boolean): void;
  title?: string;
  children: ReactNode;
  wide?: boolean;
  label?: string;
}) {
  return (
    <ModalOverlay isOpen={isOpen} onOpenChange={onOpenChange} isDismissable className="sheet-overlay">
      <Modal className={`sheet glass-thick${wide ? ' sheet-wide' : ''}`}>
        <Dialog className="sheet-dialog" aria-label={title ? undefined : label}>
          {title ? (
            <Heading slot="title" className="sheet-title">
              {title}
            </Heading>
          ) : null}
          {children}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

// --- confirm() / prompt() -----------------------------------------------------------------------

interface Ask {
  kind: 'confirm' | 'prompt';
  title: string;
  text?: string;
  confirm: string;
  danger?: boolean;
  checkbox?: string;
  placeholder?: string;
  value?: string;
  resolve(value: { ok: boolean; checked: boolean; text: string }): void;
}

const useAsk = create<{ ask: Ask | null }>(() => ({ ask: null }));

export function confirm(opts: { title: string; text?: string; confirm: string; danger?: boolean; checkbox?: string }): Promise<{ ok: boolean; checked: boolean }> {
  return new Promise((resolve) => useAsk.setState({ ask: { kind: 'confirm', ...opts, resolve } }));
}

/** Asks for a short text (title of a new note, chapter…); null when cancelled. */
export function prompt(opts: { title: string; text?: string; confirm: string; placeholder?: string; value?: string }): Promise<string | null> {
  return new Promise((resolve) =>
    useAsk.setState({ ask: { kind: 'prompt', ...opts, resolve: (v) => resolve(v.ok && v.text.trim() ? v.text.trim() : null) } }),
  );
}

export function DialogHost() {
  const ask = useAsk((s) => s.ask);
  const [checked, setChecked] = useState(false);
  const [text, setText] = useState('');
  const [openFor, setOpenFor] = useState<Ask | null>(null);
  if (ask !== openFor) {
    setOpenFor(ask);
    setChecked(false);
    setText(ask?.value ?? '');
  }
  const done = (ok: boolean) => {
    ask?.resolve({ ok, checked, text });
    useAsk.setState({ ask: null });
  };
  return (
    <Sheet isOpen={ask !== null} onOpenChange={(open) => !open && done(false)} title={ask?.title ?? ''}>
      <form
        className="ask"
        onSubmit={(e) => {
          e.preventDefault();
          done(true);
        }}
      >
        {ask?.text ? <p className="ask-text">{ask.text}</p> : null}
        {ask?.kind === 'prompt' ? (
          <TextField aria-label={ask.title} value={text} onChange={setText} autoFocus className="field">
            <Input className="input" placeholder={ask.placeholder} />
          </TextField>
        ) : null}
        {ask?.checkbox ? (
          <Checkbox isSelected={checked} onChange={setChecked} className="checkbox">
            <span className="checkbox-box" aria-hidden="true">
              <Icon name="check" size={12} />
            </span>
            {ask.checkbox}
          </Checkbox>
        ) : null}
        <div className="sheet-actions">
          <Button variant="plain" onPress={() => done(false)}>
            Annuler
          </Button>
          <Button type="submit" variant={ask?.danger ? 'danger' : 'primary'} autoFocus={ask?.kind === 'confirm'}>
            {ask?.confirm ?? 'OK'}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
