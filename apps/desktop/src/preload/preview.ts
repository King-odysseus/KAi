import { contextBridge, ipcRenderer } from 'electron';

interface PreviewElementSelection {
  selector: string;
  tagName: string;
  text: string;
  html: string;
  url: string;
}

contextBridge.exposeInMainWorld('kaiPreview', {
  select: (selection: PreviewElementSelection) => ipcRenderer.sendToHost('preview:element-selected', selection),
  ready: () => ipcRenderer.sendToHost('preview:ready', true),
});

window.addEventListener('DOMContentLoaded', () => ipcRenderer.sendToHost('preview:ready', true));
