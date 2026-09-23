import { AnimatePresence, motion } from 'motion/react';
import { create } from 'zustand';
import { Button } from './Button';
import { Icon } from './Icon';

type Kind = 'info' | 'success' | 'error';

interface ToastItem {
  id: number;
  text: string;
  kind: Kind;
  action?: { label: string; run(): void };
}

const useToasts = create<{ items: ToastItem[] }>(() => ({ items: [] }));
let seq = 0;

/** Transient banner (bottom centre): the result of an action, never blocking. */
export function toast(text: string, kind: Kind = 'info', action?: ToastItem['action']): void {
  const id = ++seq;
  useToasts.setState((s) => ({ items: [...s.items.slice(-2), { id, text, kind, action }] }));
  setTimeout(() => useToasts.setState((s) => ({ items: s.items.filter((t) => t.id !== id) })), kind === 'error' ? 6000 : 3400);
}

export function Toasts() {
  const items = useToasts((s) => s.items);
  return (
    <div className="toasts" role="status" aria-live="polite">
      <AnimatePresence initial={false}>
        {items.map((t) => (
          <motion.div
            key={t.id}
            layout
            className={`toast glass-thick ${t.kind}`}
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 520, damping: 34 }}
          >
            <Icon name={t.kind === 'error' ? 'alert' : t.kind === 'success' ? 'check' : 'ghost'} size={16} />
            <span>{t.text}</span>
            {t.action ? (
              <Button
                size="s"
                variant="plain"
                onPress={() => {
                  t.action?.run();
                  useToasts.setState((s) => ({ items: s.items.filter((x) => x.id !== t.id) }));
                }}
              >
                {t.action.label}
              </Button>
            ) : null}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
