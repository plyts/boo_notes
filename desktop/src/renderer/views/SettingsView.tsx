import { useEffect, useState, type ReactNode } from 'react';
import { Disclosure, DisclosurePanel, Button as AriaButton, Heading } from 'react-aria-components';
import type { SettingsPatch, SettingsView as Settings, Theme } from '../../ipc';
import { errorMessage, relativeTime } from '../lib/format';
import { LargeTitle, PageHeader } from '../shell/PageHeader';
import { useApp } from '../store';
import { Button, Icon, Segmented, Switch, TextField, toast } from '../ui';

const INTEGRATIONS_URL = 'https://www.notion.so/profile/integrations';

function Group({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="set-group" id={`set-${id}`} aria-labelledby={`h-${id}`}>
      <h2 id={`h-${id}`}>{title}</h2>
      <div className="set-card glass">{children}</div>
    </section>
  );
}

function Row({ label, desc, children }: { label: string; desc?: ReactNode; children?: ReactNode }) {
  return (
    <div className="set-row">
      <span className="set-text">
        <span className="set-label">{label}</span>
        {desc ? <span className="set-desc">{desc}</span> : null}
      </span>
      {children}
    </div>
  );
}

function Status({ tone, label, desc, children }: { tone: 'ok' | 'wait' | 'error'; label: string; desc: ReactNode; children?: ReactNode }) {
  return (
    <div className={`conn-status ${tone}`}>
      <span className="orb" aria-hidden="true" />
      <span className="set-text">
        <span className="set-label">{label}</span>
        <span className="set-desc">{desc}</span>
      </span>
      {children}
    </div>
  );
}

/** Réglages: extension pairing, Notion, notes folder, general. */
export function SettingsView({ section }: { section?: string }) {
  const settings = useApp((s) => s.settings);
  const status = useApp((s) => s.status);
  const setSettings = useApp((s) => s.setSettings);
  const [draft, setDraft] = useState({ token: '', target: '' });
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    if (section) document.getElementById(`set-${section}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [section]);

  if (!settings) return null;
  const s: Settings = { ...settings, notion: status?.notion ?? settings.notion };
  const save = async (patch: SettingsPatch) => {
    try {
      setSettings(await window.boo.settings.set(patch));
    } catch (e) {
      toast(errorMessage(e), 'error');
      setSettings(await window.boo.settings.get());
    }
  };
  const clients = status?.extension.clients ?? 0;
  const extError = status?.extension.error;
  const n = s.notion;
  const isWin = s.platform === 'win32';

  return (
    <div className="page">
      <PageHeader crumbs={[{ label: 'Réglages' }]} />
      <div className="page-content page-narrow settings">
        <LargeTitle title="Réglages" subtitle={`Boo Notes ${s.version}`} />

        <Group id="extension" title="Extension du navigateur">
          <Status
            tone={extError ? 'error' : clients ? 'ok' : 'wait'}
            label={extError ? 'Serveur local indisponible' : clients ? 'Extension connectée' : 'En attente de l’extension'}
            desc={
              extError ??
              (clients
                ? `${clients} navigateur${clients > 1 ? 's' : ''} relié${clients > 1 ? 's' : ''} · ws://localhost:${s.port}`
                : 'Dans l’extension : Réglages › App Desktop, collez le jeton ci-dessous.')
            }
          />
          <div className="token-block">
            <span className="set-label">Jeton d’appairage</span>
            <div className="token-row">
              <code className="token" id="pairing-token">
                {s.token}
              </code>
              <Button size="s" icon="copy" onPress={() => void window.boo.settings.copy(s.token).then(() => toast('Jeton copié', 'success'))}>
                Copier
              </Button>
              <Button
                size="s"
                variant="plain"
                onPress={async () => {
                  setSettings(await window.boo.settings.regenerateToken());
                  toast('Nouveau jeton : collez-le dans l’extension', 'info');
                }}
              >
                Nouveau jeton
              </Button>
            </div>
            <span className="set-desc">
              Il empêche les autres programmes de votre ordinateur d’écrire dans vos notes. L’adresse à saisir dans l’extension est{' '}
              <code>ws://localhost:{s.port}</code>.
            </span>
          </div>
          <Disclosure className="advanced">
            <Heading className="advanced-head">
              <AriaButton slot="trigger" className="advanced-trigger">
                <Icon name="chevronRight" size={12} className="advanced-chevron" />
                Avancé
              </AriaButton>
            </Heading>
            <DisclosurePanel>
              <Row label="Port local" desc="Uniquement sur cet ordinateur (127.0.0.1).">
                <input
                  className="input port-input"
                  type="number"
                  min={1024}
                  max={65535}
                  defaultValue={s.port}
                  aria-label="Port"
                  onBlur={(e) => Number(e.currentTarget.value) !== s.port && void save({ port: Number(e.currentTarget.value) })}
                />
              </Row>
            </DisclosurePanel>
          </Disclosure>
        </Group>

        <Group id="notion" title="Notion">
          {n.connected ? (
            <>
              <Status
                tone={n.lastError ? 'error' : 'ok'}
                label={`Connecté à ${n.workspace ?? 'Notion'}`}
                desc={n.lastError ?? (n.lastSyncAt ? `Dernière synchronisation ${relativeTime(n.lastSyncAt)}` : 'Tableau « Boo Notes — Mes notes » prêt')}
              >
                <Button size="s" icon="popout" onPress={() => void window.boo.notion.open()}>
                  Ouvrir le tableau
                </Button>
              </Status>
              <Row label="Synchronisation automatique" desc="Chaque note, progression, surlignage et lien part vers Notion quelques secondes après la modification.">
                <Switch isSelected={n.autoSync} onChange={(v) => void save({ notionAutoSync: v })}>
                  <span className="sr-only">Synchronisation automatique</span>
                </Switch>
              </Row>
              <Row label="Synchroniser aussi depuis le navigateur" desc="L’extension reçoit cette connexion : vos notes en ligne partent vers Notion même quand Boo Notes est fermé.">
                <Switch isSelected={n.share} onChange={(v) => void save({ notionShare: v })}>
                  <span className="sr-only">Partager la connexion Notion avec l’extension</span>
                </Switch>
              </Row>
              <Row label="Toutes les notes" desc="Une page par note, avec ses colonnes Cours, Chapitre, Supports, Statut et Liens.">
                <span className="row-actions">
                  <Button
                    size="s"
                    icon="refresh"
                    isDisabled={n.syncing > 0}
                    onPress={async () => {
                      try {
                        const res = await window.boo.notion.syncAll();
                        toast(
                          res.failed ? `${res.ok} notes synchronisées, ${res.failed} en erreur` : `${res.ok} notes synchronisées`,
                          res.failed ? 'error' : 'success',
                        );
                      } catch (e) {
                        toast(errorMessage(e), 'error');
                      }
                    }}
                  >
                    {n.syncing ? 'Synchronisation…' : 'Tout synchroniser'}
                  </Button>
                  <Button size="s" variant="plain" onPress={async () => setSettings(await window.boo.notion.disconnect())}>
                    Déconnecter
                  </Button>
                </span>
              </Row>
            </>
          ) : (
            <form
              className="notion-setup"
              onSubmit={async (e) => {
                e.preventDefault();
                setConnecting(true);
                try {
                  setSettings(await window.boo.notion.connect(draft.token, draft.target));
                  setDraft({ token: '', target: '' });
                  toast('Notion est connecté : le tableau « Boo Notes — Mes notes » a été ajouté à votre page', 'success');
                } catch (err) {
                  toast(errorMessage(err), 'error');
                } finally {
                  setConnecting(false);
                }
              }}
            >
              <ol className="notion-steps">
                <li>
                  <strong>Créez une intégration</strong>
                  <span>
                    Sur{' '}
                    <button type="button" className="link" onClick={() => void window.boo.settings.openExternal(INTEGRATIONS_URL)}>
                      notion.so › Intégrations
                    </button>
                    , « Nouvelle intégration » (type interne), puis copiez son secret.
                  </span>
                </li>
                <li>
                  <strong>Partagez une page</strong>
                  <span>
                    Ouvrez la page qui rassemblera vos notes (ex. « Mes études ») › ••• › Connexions › ajoutez l’intégration. Boo Notes y insère un
                    tableau de toutes vos notes.
                  </span>
                </li>
                <li>
                  <strong>Collez-les ici</strong>
                  <span className="notion-fields">
                    <TextField label="Secret de l’intégration" type="password" value={draft.token} onChange={(v) => setDraft({ ...draft, token: v })} placeholder="ntn_… ou secret_…" />
                    <TextField
                      label="Lien de la page (ou d’une base existante)"
                      type="url"
                      value={draft.target}
                      onChange={(v) => setDraft({ ...draft, target: v })}
                      placeholder="https://www.notion.so/…"
                    />
                  </span>
                </li>
              </ol>
              <div className="card-actions">
                <Button type="submit" variant="primary" icon="notion" isDisabled={connecting || !draft.token.trim() || !draft.target.trim()}>
                  {connecting ? 'Connexion…' : 'Connecter Notion'}
                </Button>
              </div>
              <p className="set-desc privacy">
                <Icon name="eye" size={14} />
                <span>Le secret est chiffré par le système sur cet ordinateur et n’est envoyé qu’à Notion.</span>
              </p>
            </form>
          )}
        </Group>

        <Group id="vault" title="Dossier de notes">
          <Row label="Emplacement" desc={<code className="path">{s.vault}</code>}>
            <span className="row-actions">
              <Button size="s" icon="folder" onPress={() => void window.boo.settings.openVault()}>
                Ouvrir
              </Button>
              <Button size="s" onPress={async () => setSettings(await window.boo.settings.chooseVault())}>
                Changer…
              </Button>
            </span>
          </Row>
          <p className="set-desc inset">
            Un fichier Markdown par note, lisible par n’importe quel éditeur (Obsidian, VS Code…), les captures dans <code>assets/</code>, les cours et
            chapitres dans <code>.boo/library.json</code>.
          </p>
        </Group>

        <Group id="general" title="Général">
          <Row
            label={isWin ? 'Lancer au démarrage de Windows' : 'Lancer à l’ouverture de session'}
            desc="Discrètement, dans la zone de notification : l’extension trouve toujours l’application."
          >
            <Switch isSelected={s.openAtLogin} onChange={(v) => void save({ openAtLogin: v })}>
              <span className="sr-only">Lancer au démarrage</span>
            </Switch>
          </Row>
          <Row label="Garder en arrière-plan" desc="Fermer la fenêtre laisse Boo Notes dans la zone de notification.">
            <Switch isSelected={s.closeToTray} onChange={(v) => void save({ closeToTray: v })}>
              <span className="sr-only">Garder en arrière-plan</span>
            </Switch>
          </Row>
          <Row label="Apparence" desc="Automatique suit le réglage du système.">
            <Segmented<Theme>
              label="Apparence"
              value={s.theme}
              onChange={(v) => void save({ theme: v })}
              options={[
                { id: 'auto', label: 'Auto' },
                { id: 'light', label: 'Clair' },
                { id: 'dark', label: 'Sombre' },
              ]}
            />
          </Row>
          <Row
            label="Typographie"
            desc={
              s.platform === 'darwin'
                ? 'San Francisco (SF Pro Text / Display / Rounded), la police du système.'
                : 'Inter Variable, intégrée : la plus proche de San Francisco, dont la licence réserve l’usage aux appareils Apple.'
            }
          />
        </Group>
      </div>
    </div>
  );
}
