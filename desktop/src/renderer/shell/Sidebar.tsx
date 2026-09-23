import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import {
  Button as AriaButton,
  Collection,
  isTextDropItem,
  Tree,
  TreeItem,
  TreeItemContent,
  useDragAndDrop,
} from 'react-aria-components';
import { newCourse, newNote } from '../actions';
import { errorMessage } from '../lib/format';
import { courseColor } from '../lib/kinds';
import { useApp, type Route } from '../store';
import { Icon, IconButton, Ring, toast, type IconName } from '../ui';

/** Drag type of a note (lists → chapters of the sidebar). */
export const NOTE_DRAG = 'application/x-boo-note';

interface NavEntry {
  route: Route;
  label: string;
  icon: IconName;
  badge?: number;
  shortcut?: string;
}

function isActive(route: Route, current: Route): boolean {
  if (route.name !== current.name) return false;
  if (route.name === 'notes' && current.name === 'notes') return route.filter === current.filter;
  return true;
}

function NavItem({ entry }: { entry: NavEntry }) {
  const current = useApp((s) => s.route);
  const go = useApp((s) => s.go);
  const active = isActive(entry.route, current);
  return (
    <AriaButton
      className="nav-item"
      data-active={active || undefined}
      aria-current={active ? 'page' : undefined}
      onPress={() => go(entry.route)}
    >
      {active ? <motion.span layoutId="nav-active" className="nav-active" transition={{ type: 'spring', stiffness: 520, damping: 40 }} /> : null}
      <Icon name={entry.icon} size={17} />
      <span className="nav-label">{entry.label}</span>
      {entry.badge ? <span className="nav-badge">{entry.badge}</span> : null}
    </AriaButton>
  );
}

interface TreeNode {
  id: string;
  kind: 'course' | 'chapter';
  courseId: string;
  chapterId?: string;
  title: string;
  emoji?: string;
  hue: number;
  ratio?: number;
  count: number;
  children?: TreeNode[];
}

function CoursesTree() {
  const courses = useApp((s) => s.snap.courses);
  const expanded = useApp((s) => s.expanded);
  const setExpanded = useApp((s) => s.setExpanded);
  const route = useApp((s) => s.route);
  const go = useApp((s) => s.go);
  const items: TreeNode[] = courses.map((c) => ({
    id: c.id,
    kind: 'course',
    courseId: c.id,
    title: c.title,
    emoji: c.emoji,
    hue: c.hue,
    ratio: c.ratio,
    count: c.noteCount,
    children: c.chapters.map((ch) => ({
      id: `${c.id}|${ch.id}`,
      kind: 'chapter' as const,
      courseId: c.id,
      chapterId: ch.id,
      title: ch.title,
      hue: c.hue,
      count: ch.notes.length,
    })),
  }));

  // Notes dragged from any list are filed by dropping them on a course or a chapter.
  const { dragAndDropHooks } = useDragAndDrop<TreeNode>({
    acceptedDragTypes: [NOTE_DRAG],
    getDropOperation: (target) => (target.type === 'item' && target.dropPosition === 'on' ? 'move' : 'cancel'),
    onItemDrop: async (e) => {
      const key = String(e.target.key);
      const [courseId, chapterId] = key.split('|');
      const course = useApp.getState().courses.get(courseId);
      const dest = chapterId ?? course?.chapters[0]?.id;
      if (!course || !dest) return;
      const ids = await Promise.all(e.items.filter(isTextDropItem).map((item) => item.getText(NOTE_DRAG)));
      try {
        for (const id of ids) await window.boo.library.placeNote(id, { courseId, chapterId: dest });
        const chapter = course.chapters.find((c) => c.id === dest);
        toast(`${ids.length > 1 ? `${ids.length} notes classées` : 'Note classée'} dans « ${chapter?.title ?? course.title} »`, 'success');
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
    },
  });

  if (!items.length) {
    return (
      <button type="button" className="courses-empty" onClick={() => void newCourse()}>
        <Icon name="plus" size={14} />
        Créer votre premier cours
      </button>
    );
  }

  const renderNode = (node: TreeNode): ReactNode => {
    const active =
      route.name === 'course' && route.id === node.courseId && node.kind === 'course';
    return (
      <TreeItem
        id={node.id}
        textValue={node.title}
        className="tree-item"
        data-kind={node.kind}
        data-active={active || undefined}
        onAction={() => go({ name: 'course', id: node.courseId })}
      >
        <TreeItemContent>
          {({ hasChildItems, isExpanded }) => (
            <div className="tree-row" style={{ ['--course' as string]: courseColor(node.hue) }}>
              {hasChildItems ? (
                <AriaButton slot="chevron" className="tree-chevron" aria-label={isExpanded ? 'Replier' : 'Déplier'}>
                  <Icon name="chevronRight" size={12} />
                </AriaButton>
              ) : (
                <span className="tree-chevron-space" />
              )}
              {node.kind === 'course' ? (
                <span className="tree-emoji" aria-hidden="true">
                  {node.emoji}
                </span>
              ) : (
                <span className="tree-dot" aria-hidden="true" />
              )}
              <span className="tree-title">{node.title}</span>
              {node.kind === 'course' ? (
                <Ring value={node.ratio ?? 0} size={16} stroke={2.5} color={courseColor(node.hue)} label={`Progression : ${Math.round((node.ratio ?? 0) * 100)} %`} />
              ) : node.count ? (
                <span className="tree-count">{node.count}</span>
              ) : null}
            </div>
          )}
        </TreeItemContent>
        {node.children ? <Collection items={node.children}>{renderNode}</Collection> : null}
      </TreeItem>
    );
  };

  return (
    <Tree
      aria-label="Cours et chapitres"
      className="tree"
      items={items}
      expandedKeys={expanded}
      onExpandedChange={(keys) => setExpanded([...keys].map(String))}
      dragAndDropHooks={dragAndDropHooks}
    >
      {renderNode}
    </Tree>
  );
}

function StatusFooter() {
  const status = useApp((s) => s.status);
  const go = useApp((s) => s.go);
  const ext = status?.extension;
  const notion = status?.notion;
  return (
    <div className="sidebar-footer">
      <AriaButton className="status-pill" onPress={() => go({ name: 'settings', section: 'extension' })}>
        <span className="status-dot" data-state={ext?.error ? 'error' : ext?.clients ? 'ok' : 'idle'} />
        <span className="status-text">
          {ext?.error ? 'Extension : erreur' : ext?.clients ? (ext.active ? `En lecture : ${ext.active.title}` : 'Extension connectée') : 'Extension en attente'}
        </span>
      </AriaButton>
      <AriaButton className="status-pill" onPress={() => go({ name: 'settings', section: 'notion' })}>
        <Icon name="notion" size={14} />
        <span className="status-text">
          {notion?.connected ? (notion.syncing ? 'Synchronisation…' : 'Notion connecté') : 'Notion non connecté'}
        </span>
      </AriaButton>
    </div>
  );
}

export function Sidebar() {
  const snap = useApp((s) => s.snap);
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const toggle = useApp((s) => s.toggleSidebar);
  const setPalette = useApp((s) => s.setPalette);
  const go = useApp((s) => s.go);
  const due = snap.notes.filter((n) => n.due).length;
  const mod = window.boo.platform === 'darwin' ? '⌘' : 'Ctrl';
  const nav: NavEntry[] = [
    { route: { name: 'today' }, label: 'Accueil', icon: 'home' },
    { route: { name: 'review' }, label: 'À réviser', icon: 'cards', badge: due },
    { route: { name: 'graph' }, label: 'Carte mentale', icon: 'mindmap' },
    { route: { name: 'notes', filter: 'all' }, label: 'Toutes les notes', icon: 'list' },
    { route: { name: 'resources', kind: 'all' }, label: 'Supports', icon: 'library' },
    { route: { name: 'notes', filter: 'inbox' }, label: 'Non classées', icon: 'inbox', badge: snap.inbox.length },
  ];
  return (
    <motion.aside
      className="sidebar glass"
      aria-label="Navigation"
      initial={false}
      animate={{ x: collapsed ? -290 : 0, opacity: collapsed ? 0 : 1 }}
      transition={{ type: 'spring', stiffness: 380, damping: 38 }}
      inert={collapsed || undefined}
    >
      <div className="sidebar-top">
        <IconButton icon="sidebar" label="Masquer la barre latérale" shortcut={`${mod} \\`} onPress={toggle} />
      </div>
      <AriaButton className="sidebar-search" onPress={() => setPalette(true)}>
        <Icon name="search" size={15} />
        <span>Rechercher</span>
        <kbd>{mod} K</kbd>
      </AriaButton>
      <nav className="nav" aria-label="Vues">
        {nav.map((e) => (
          <NavItem key={JSON.stringify(e.route)} entry={e} />
        ))}
      </nav>
      <div className="sidebar-section">
        <span className="sidebar-heading">Cours</span>
        <IconButton icon="plus" size="s" label="Nouveau cours" onPress={() => void newCourse()} />
      </div>
      <div className="sidebar-scroll">
        <CoursesTree />
      </div>
      <div className="sidebar-actions">
        <AriaButton className="sidebar-new" onPress={() => void newNote()}>
          <Icon name="edit" size={15} />
          Nouvelle note
        </AriaButton>
        <IconButton icon="settings" label="Réglages" shortcut={`${mod} ,`} onPress={() => go({ name: 'settings' })} />
      </div>
      <StatusFooter />
    </motion.aside>
  );
}
