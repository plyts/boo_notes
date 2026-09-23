import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './shell/App';
import { useApp } from './store';

const root = document.documentElement;
root.dataset.platform = window.boo.platform;
root.dataset.material = window.boo.material ? 'system' : 'none';

const dark = matchMedia('(prefers-color-scheme: dark)');
function applyTheme(): void {
  const theme = useApp.getState().settings?.theme ?? 'auto';
  root.dataset.theme = theme === 'auto' ? (dark.matches ? 'dark' : 'light') : theme;
}
dark.addEventListener('change', applyTheme);
useApp.subscribe((s, prev) => {
  if (s.settings?.theme !== prev.settings?.theme) applyTheme();
});
applyTheme();

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
