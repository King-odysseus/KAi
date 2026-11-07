import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from 'flowbite-react';
import { App } from './App';
import { kaiFlowbiteTheme } from './flowbite-theme';
import './design-system.css';
import './styles.css';
import './ops.css';
import './themes.css';
import './themes.generated.css';
import './uap-dashboard.css';
import './controls.css';
import './workspace-polish.css';
import './vscode.css';
import './code-side.css';
import './ui-upgrade.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider theme={kaiFlowbiteTheme}><App /></ThemeProvider>
  </StrictMode>,
);
