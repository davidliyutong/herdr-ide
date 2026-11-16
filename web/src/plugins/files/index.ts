// The file explorer (docs/features/28-file-explorer.md): a panel of the
// right sidebar with the shown machine's files, and an editor pane for
// text files. The core's side is internal/plugins/files, the machine's
// internal/agent/plugin/files.
import { FilePen, Files } from 'lucide-react';
import type { PluginDef } from '../api';
import type { PluginView } from '../../term/layout';
import { FilesPanel } from './FilesPanel';
import { EditorPane } from './EditorPane';
import { baseName, parentOf } from './tree';

export { registerFileDecorations, refreshDecorations } from './decorations';
export type { DecorationProvider, FileDecoration } from './decorations';

const pathOf = (v: PluginView) => (typeof v.path === 'string' ? v.path : '');

export const filesPlugin: PluginDef = {
  id: 'files',
  title: 'files.title',
  description: 'files.description',
  icon: Files,
  panels: [{ id: 'files', title: 'files.title', icon: Files, component: FilesPanel, command: 'view.panel.files' }],
  paneViews: {
    editor: {
      icon: FilePen,
      title: (_m, v) => baseName(pathOf(v)) || 'editor',
      path: (_m, v) => pathOf(v) || undefined,
      directory: (_m, v) => (pathOf(v) ? parentOf(pathOf(v)) : undefined),
      preview: (_m, v) => v.preview === true,
      component: EditorPane,
    },
  },
};
