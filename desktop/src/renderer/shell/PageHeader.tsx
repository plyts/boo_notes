import type { ReactNode } from 'react';
import { Breadcrumb, Breadcrumbs, Link } from 'react-aria-components';
import { useApp, type Route } from '../store';
import { IconButton } from '../ui';

export interface Crumb {
  label: string;
  route?: Route;
}

/**
 * Floating toolbar of a view (Liquid Glass): history, breadcrumb, actions.
 * The large title lives in the content below it, which scrolls under the glass.
 */
export function PageHeader({ crumbs = [], actions, center }: { crumbs?: Crumb[]; actions?: ReactNode; center?: ReactNode }) {
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const toggle = useApp((s) => s.toggleSidebar);
  const back = useApp((s) => s.back.length);
  const forward = useApp((s) => s.forward.length);
  const goBack = useApp((s) => s.goBack);
  const goForward = useApp((s) => s.goForward);
  const go = useApp((s) => s.go);
  const mod = window.boo.platform === 'darwin' ? '⌘' : 'Ctrl';
  return (
    <header className="page-toolbar">
      <div className="toolbar-group glass-clear">
        {collapsed ? <IconButton icon="sidebar" label="Afficher la barre latérale" shortcut={`${mod} \\`} onPress={toggle} /> : null}
        <IconButton icon="chevronLeft" label="Précédent" shortcut="Alt ←" isDisabled={!back} onPress={goBack} />
        <IconButton icon="chevronRight" label="Suivant" shortcut="Alt →" isDisabled={!forward} onPress={goForward} />
      </div>
      {crumbs.length ? (
        <Breadcrumbs className="crumbs" items={crumbs.map((c, i) => ({ ...c, id: i }))}>
          {(c) => (
            <Breadcrumb className="crumb">
              {c.route ? (
                <Link className="crumb-link" onPress={() => c.route && go(c.route)}>
                  {c.label}
                </Link>
              ) : (
                <span className="crumb-current">{c.label}</span>
              )}
            </Breadcrumb>
          )}
        </Breadcrumbs>
      ) : (
        <span className="toolbar-spacer" />
      )}
      {center ? <div className="toolbar-center">{center}</div> : null}
      <span className="toolbar-spacer" />
      {actions ? <div className="toolbar-actions">{actions}</div> : null}
    </header>
  );
}

/** Large title block at the top of a view. */
export function LargeTitle({ title, subtitle, leading, children }: { title: ReactNode; subtitle?: ReactNode; leading?: ReactNode; children?: ReactNode }) {
  return (
    <div className="large-title">
      {leading ? <div className="large-title-leading">{leading}</div> : null}
      <div className="large-title-text">
        <h1>{title}</h1>
        {subtitle ? <p className="large-subtitle">{subtitle}</p> : null}
      </div>
      {children ? <div className="large-title-actions">{children}</div> : null}
    </div>
  );
}
