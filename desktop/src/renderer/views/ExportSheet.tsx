import { useEffect, useState } from 'react';
import { Checkbox, CheckboxGroup, Label } from 'react-aria-components';
import type { ExportResult } from '../../ipc';
import { errorMessage, plural } from '../lib/format';
import { courseColor } from '../lib/kinds';
import { useApp } from '../store';
import { Button, Icon, Sheet, Switch, toast, type IconName } from '../ui';

type Format = 'markdown' | 'sheets' | 'cards' | 'json';

const FORMATS: Array<{ id: Format; icon: IconName; label: string; desc: string }> = [
  { id: 'sheets', icon: 'file', label: 'Fiches de révision', desc: 'Un PDF à imprimer : cours › chapitres › notes, cartes en fin de fiche.' },
  { id: 'cards', icon: 'cards', label: 'Cartes Anki / Quizlet', desc: 'Vos « Question :: Réponse » et ==mots cachés==, un paquet par cours.' },
  { id: 'markdown', icon: 'text', label: 'Dossiers Markdown', desc: 'Un dossier par cours et chapitre, une note par fichier, captures incluses.' },
  { id: 'json', icon: 'sparkles', label: 'Données JSON (QCM)', desc: 'Tout, structuré : la base pour générer des QCM plus tard.' },
];

function Check({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <Checkbox value={value} className="check-card">
      {({ isSelected }) => (
        <>
          <span className={`checkbox-box${isSelected ? ' on' : ''}`} aria-hidden="true">
            <Icon name="check" size={12} />
          </span>
          {children}
        </>
      )}
    </Checkbox>
  );
}

/** Export of courses and notes: revision sheets, flashcards, Markdown tree, JSON. */
export function ExportSheet() {
  const open = useApp((s) => s.exportOpen);
  const setOpen = useApp((s) => s.setExport);
  const courses = useApp((s) => s.snap.courses);
  const inbox = useApp((s) => s.snap.inbox.length);
  const route = useApp((s) => s.route);
  const [formats, setFormats] = useState<string[]>(['sheets', 'cards']);
  const [picked, setPicked] = useState<string[]>([]);
  const [unfiled, setUnfiled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setResult(null);
    // From a course, that course is proposed; otherwise all of them.
    setPicked(route.name === 'course' ? [route.id] : courses.map((c) => c.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const run = async () => {
    setBusy(true);
    try {
      const res = await window.boo.export.run({ formats: formats as Format[], courses: picked, includeUnfiled: unfiled });
      if (res) setResult(res);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const count = courses.filter((c) => picked.includes(c.id)).reduce((s, c) => s + c.noteCount, 0) + (unfiled ? inbox : 0);

  return (
    <Sheet isOpen={open} onOpenChange={setOpen} title="Exporter mes cours" wide>
      {result ? (
        <div className="export-done">
          <span className="review-done-icon">
            <Icon name="check" size={26} />
          </span>
          <p>
            <strong>{plural(result.notes, 'note')}</strong> et <strong>{plural(result.cards, 'carte')}</strong> exportées dans
            <br />
            <code className="path">{result.folder}</code>
          </p>
          <ul className="export-files">
            {result.files.slice(0, 8).map((f) => (
              <li key={f}>
                <Icon name="file" size={13} /> {f}
              </li>
            ))}
            {result.files.length > 8 ? <li>… et {result.files.length - 8} autres fichiers</li> : null}
          </ul>
          {result.warnings.length ? (
            <ul className="export-warnings">
              {result.warnings.map((w) => (
                <li key={w}>
                  <Icon name="alert" size={13} /> {w}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="sheet-actions">
            <Button variant="primary" onPress={() => setOpen(false)}>
              Terminé
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="export-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <CheckboxGroup className="check-grid" value={formats} onChange={setFormats}>
            <Label className="field-label">Formats</Label>
            {FORMATS.map((f) => (
              <Check key={f.id} value={f.id}>
                <Icon name={f.icon} size={18} />
                <span className="check-text">
                  <strong>{f.label}</strong>
                  <small>{f.desc}</small>
                </span>
              </Check>
            ))}
          </CheckboxGroup>

          {courses.length ? (
            <CheckboxGroup className="course-checks" value={picked} onChange={setPicked}>
              <Label className="field-label">
                Cours{' '}
                <button
                  type="button"
                  className="link"
                  onClick={() => setPicked(picked.length === courses.length ? [] : courses.map((c) => c.id))}
                >
                  {picked.length === courses.length ? 'Aucun' : 'Tous'}
                </button>
              </Label>
              {courses.map((c) => (
                <Checkbox key={c.id} value={c.id} className="course-check" style={{ ['--course' as string]: courseColor(c.hue) }}>
                  {({ isSelected }) => (
                    <>
                      <span className={`checkbox-box${isSelected ? ' on' : ''}`} aria-hidden="true">
                        <Icon name="check" size={12} />
                      </span>
                      <span className="course-check-emoji">{c.emoji}</span>
                      <span className="check-text">
                        <strong>{c.title}</strong>
                        <small>
                          {plural(c.chapters.length, 'chapitre')} · {plural(c.noteCount, 'note')}
                        </small>
                      </span>
                    </>
                  )}
                </Checkbox>
              ))}
            </CheckboxGroup>
          ) : null}
          {inbox ? (
            <Switch isSelected={unfiled} onChange={setUnfiled}>
              {inbox > 1 ? `Inclure les ${inbox} notes non classées` : 'Inclure la note non classée'}
            </Switch>
          ) : null}
          <p className="set-desc">
            Les cartes viennent de vos notes : <code>Question :: Réponse</code>, une ligne suivie de <code>?</code> puis la réponse, un titre{' '}
            <code>## …?</code>, ou <code>==mot==</code> pour un texte à trous.
          </p>
          <div className="sheet-actions">
            <Button variant="plain" onPress={() => setOpen(false)}>
              Annuler
            </Button>
            <Button type="submit" variant="primary" icon="export" isDisabled={busy || !formats.length || !count}>
              {busy ? 'Export…' : `Exporter ${plural(count, 'note')}…`}
            </Button>
          </div>
        </form>
      )}
    </Sheet>
  );
}
